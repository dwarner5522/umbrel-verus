'use strict'

// Supervises verusd and serves the dashboard, its JSON API and the Umbrel widgets.
// No npm dependencies: everything here is Node's standard library.

const http = require('node:http')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const {spawn} = require('node:child_process')
const {createChains, writeRootConf} = require('./chains')

const HOME = process.env.HOME || '/data'

const config = {
	httpPort: Number(process.env.PORT || 3000),
	verusdBin: process.env.VERUSD_BIN || '/usr/local/bin/verusd',
	dataDir: process.env.VERUS_DATA_DIR || path.join(HOME, '.komodo', 'VRSC'),
	paramsDir: path.join(HOME, '.zcash-params'),
	paramsUrl: process.env.ZCASH_PARAMS_URL || 'https://verus.io/zcparams',
	p2pPort: Number(process.env.P2P_PORT || 27485),
	rpcPort: Number(process.env.RPC_PORT || 27486),
	rpcUser: process.env.RPC_USER || 'umbrel',
	rpcPass: process.env.RPC_PASS || '',
	appsSubnet: process.env.APPS_SUBNET || '',
	extraArgs: (process.env.VERUSD_EXTRA_ARGS || '').split(',').map((arg) => arg.trim()).filter(Boolean),
	// Startup flags for each PBaaS chain daemon (vARRR, vDEX, CHIPS, …), comma-delimited like VERUSD_EXTRA_ARGS.
	// The defaults keep a chain daemon small: few peers, a small cache, one script verification thread.
	pbaasExtraArgs: (process.env.PBAAS_EXTRA_ARGS ?? '-maxconnections=8,-dbcache=64,-par=1,-maxsigcachesize=16,-checkblocks=12').split(',').map((arg) => arg.trim()).filter(Boolean),
	deviceDomainName: process.env.DEVICE_DOMAIN_NAME || '',
	// Status page of the Electrum server container that ships in the same Umbrel app, if any.
	electrumUrl: (process.env.ELECTRUM_STATUS_URL || '').replace(/\/+$/, ''),
}

// Same files and hashes as the fetch-params script shipped with the Verus CLI.
const PARAMS = [
	{name: 'sapling-spend.params', sha256: '8e48ffd23abb3a5fd9c5589204f32d9c31285a04b78096ba40a79b75677efc13'},
	{name: 'sapling-output.params', sha256: '2f0ebbcbb9bb0bcffe95a397e7eba89c29eb4dde6191c339db88570e3f3fb0e4'},
	{name: 'sprout-groth16.params', sha256: 'b685d700c60328498fbde589c8c7c484c722b788b265b72af448a5bf0ee55b50'},
]

// Holds the number of bootstrap attempts so far. It stays in place until the bootstrap has
// finished, so one interrupted by a restart is picked up again instead of leaving an empty chain.
const BOOTSTRAP_MARKER = path.join(HOME, '.bootstrap-requested')
const BOOTSTRAP_MAX_ATTEMPTS = 3
const RESTART_DELAY_MS = 15_000
const POLL_INTERVAL_MS = 3_000

const state = {
	// params -> starting -> running; bootstrapping while verusd restores the bootstrap archive
	phase: 'params',
	message: 'Preparing…',
	error: null,
	params: {file: null, index: 0, total: PARAMS.length, received: 0, size: 0},
	daemon: {pid: null, startedAt: null, lastExit: null},
	rpcStatus: null,
	node: null,
	peers: [],
	// null when this image runs without an Electrum server next to it
	electrum: null,
	updatedAt: null,
}

let child = null
let shuttingDown = false
let restartTimer = null
let restartNow = false
let pollTimer = null
let chainsTimer = null
let electrumTimer = null

const log = (...args) => console.log(new Date().toISOString(), ...args)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ---------------------------------------------------------------------------
// zk-SNARK parameters

async function exists(file) {
	try {
		await fsp.access(file)
		return true
	} catch {
		return false
	}
}

async function downloadParam(param, index) {
	const target = path.join(config.paramsDir, param.name)
	if (await exists(target)) return

	const partial = `${target}.dl`
	state.params = {file: param.name, index, total: PARAMS.length, received: 0, size: 0}
	state.message = `Downloading ${param.name}`
	log(`Downloading ${param.name}`)

	const response = await fetch(`${config.paramsUrl}/${param.name}`)
	if (!response.ok || !response.body) throw new Error(`${param.name}: HTTP ${response.status}`)
	state.params.size = Number(response.headers.get('content-length') || 0)

	const hash = crypto.createHash('sha256')
	const file = fs.createWriteStream(partial)
	try {
		for await (const chunk of response.body) {
			hash.update(chunk)
			state.params.received += chunk.length
			if (!file.write(chunk)) await new Promise((resolve) => file.once('drain', resolve))
		}
	} finally {
		await new Promise((resolve) => file.end(resolve))
	}

	if (hash.digest('hex') !== param.sha256) {
		await fsp.rm(partial, {force: true})
		throw new Error(`${param.name}: checksum mismatch`)
	}
	await fsp.rename(partial, target)
	log(`Verified ${param.name}`)
}

async function ensureParams() {
	await fsp.mkdir(config.paramsDir, {recursive: true})
	for (;;) {
		try {
			for (const [index, param] of PARAMS.entries()) await downloadParam(param, index)
			state.error = null
			return
		} catch (error) {
			log('Parameter download failed:', error.message)
			state.error = `Could not download the zk-SNARK parameters (${error.message}). Retrying…`
			await sleep(RESTART_DELAY_MS)
			if (shuttingDown) return
		}
	}
}

// ---------------------------------------------------------------------------
// verusd process

function daemonArgs(bootstrap) {
	const args = [
		`-datadir=${config.dataDir}`,
		'-server=1',
		'-showmetrics=0',
		`-port=${config.p2pPort}`,
		`-rpcport=${config.rpcPort}`,
		`-rpcuser=${config.rpcUser}`,
		`-rpcpassword=${config.rpcPass}`,
		'-rpcbind=0.0.0.0',
		'-rpcallowip=127.0.0.1',
	]
	if (config.appsSubnet) args.push(`-rpcallowip=${config.appsSubnet}`)
	if (bootstrap) args.push('-bootstrap')
	return [...args, ...config.extraArgs]
}

async function nextBootstrapAttempt() {
	let attempts
	try {
		attempts = Number(await fsp.readFile(BOOTSTRAP_MARKER, 'utf8')) || 0
	} catch {
		return false
	}
	if (attempts >= BOOTSTRAP_MAX_ATTEMPTS) {
		log('Bootstrap failed too many times, syncing from the network instead')
		await finishBootstrap()
		state.error = 'The bootstrap could not be loaded. Syncing from the network instead.'
		return false
	}
	await fsp.writeFile(BOOTSTRAP_MARKER, String(attempts + 1))
	return true
}

// verusd downloads the archive into its data directory; don't leave a partial one behind.
async function removeBootstrapArchive() {
	for (const file of ['VRSC-bootstrap.tar.gz', 'VRSC-bootstrap.tar.gz.verusid']) {
		await fsp.rm(path.join(config.dataDir, file), {force: true})
	}
}

async function finishBootstrap() {
	await fsp.rm(BOOTSTRAP_MARKER, {force: true})
	await removeBootstrapArchive()
}

async function startDaemon() {
	if (shuttingDown || child) return
	await fsp.mkdir(config.dataDir, {recursive: true})
	// the PBaaS chain daemons read the RPC details of this one from VRSC.conf
	await writeRootConf(config.dataDir, {user: config.rpcUser, pass: config.rpcPass, port: config.rpcPort}).catch((error) =>
		log('Could not update VRSC.conf:', error.message),
	)

	const bootstrap = await nextBootstrapAttempt()
	if (!bootstrap) await removeBootstrapArchive()

	state.phase = bootstrap ? 'bootstrapping' : 'starting'
	state.message = bootstrap ? 'Downloading and extracting the blockchain bootstrap…' : 'Starting verusd…'
	state.rpcStatus = null
	state.node = null
	state.peers = []

	log(`Starting verusd${bootstrap ? ' with -bootstrap' : ''}`)
	child = spawn(config.verusdBin, daemonArgs(bootstrap), {
		env: {...process.env, HOME},
		stdio: ['ignore', 'inherit', 'inherit'],
	})
	state.daemon.pid = child.pid
	state.daemon.startedAt = Date.now()

	// 'exit' is not emitted when the binary can't be spawned at all
	child.on('error', (error) => {
		log('Failed to start verusd:', error.message)
		child = null
		state.daemon.pid = null
		state.phase = 'stopped'
		state.error = `Failed to start verusd: ${error.message}`
		if (!shuttingDown) restartTimer = setTimeout(startDaemon, RESTART_DELAY_MS)
	})

	child.on('exit', (code, signal) => {
		log(`verusd exited (code=${code} signal=${signal})`)
		child = null
		state.daemon = {pid: null, startedAt: null, lastExit: {code, signal, at: Date.now()}}
		state.node = null
		state.peers = []
		if (shuttingDown) return
		state.phase = 'stopped'
		state.message = 'verusd stopped. Restarting…'
		if (code !== 0) state.error = `verusd exited unexpectedly (${signal || `code ${code}`}). See the log below.`
		restartTimer = setTimeout(startDaemon, restartNow ? 0 : RESTART_DELAY_MS)
		restartNow = false
	})
}

function stopDaemon() {
	return new Promise((resolve) => {
		if (!child) return resolve()
		child.once('exit', resolve)
		child.kill('SIGTERM')
	})
}

async function requestBootstrap() {
	await fsp.writeFile(BOOTSTRAP_MARKER, '0')
	state.phase = 'stopping'
	state.message = 'Stopping verusd to load the bootstrap…'
	state.error = null
	restartNow = true
	if (child) child.kill('SIGTERM')
	else {
		clearTimeout(restartTimer)
		startDaemon()
	}
}

// ---------------------------------------------------------------------------
// RPC

function rpc(method, params = []) {
	const body = JSON.stringify({jsonrpc: '1.0', id: 'umbrel', method, params})
	return new Promise((resolve, reject) => {
		const request = http.request(
			{
				host: '127.0.0.1',
				port: config.rpcPort,
				method: 'POST',
				auth: `${config.rpcUser}:${config.rpcPass}`,
				headers: {'content-type': 'text/plain', 'content-length': Buffer.byteLength(body)},
				timeout: 20_000,
			},
			(response) => {
				let data = ''
				response.setEncoding('utf8')
				response.on('data', (chunk) => (data += chunk))
				response.on('end', () => {
					try {
						const parsed = JSON.parse(data)
						if (parsed.error) {
							const error = new Error(parsed.error.message)
							error.code = parsed.error.code
							return reject(error)
						}
						resolve(parsed.result)
					} catch {
						reject(new Error(`Unexpected RPC response (HTTP ${response.statusCode})`))
					}
				})
			},
		)
		request.on('timeout', () => request.destroy(new Error('RPC timeout')))
		request.on('error', reject)
		request.end(body)
	})
}

async function poll() {
	if (!child || shuttingDown || state.phase === 'stopping') return
	try {
		const [info, chain, mining, mempool, network, peers] = await Promise.all([
			rpc('getinfo'),
			rpc('getblockchaininfo'),
			rpc('getmininginfo'),
			rpc('getmempoolinfo'),
			rpc('getnetworkinfo'),
			rpc('getpeerinfo'),
		])

		// longestchain is the best height our peers report; it is 0 until a peer connects.
		const target = Math.max(info.longestchain || 0, chain.headers || 0, info.blocks || 0)
		const progress = target > 0 ? Math.min(info.blocks / target, 1) : 0
		const synced = info.longestchain > 0 && info.blocks >= info.longestchain

		state.node = {
			version: info.VRSCversion,
			subversion: network.subversion,
			protocolVersion: info.protocolversion,
			chain: chain.chain,
			name: info.name,
			blocks: info.blocks,
			headers: chain.headers,
			longestChain: info.longestchain,
			progress,
			synced,
			tipTime: info.tiptime,
			bestBlockHash: chain.bestblockhash,
			difficulty: chain.difficulty,
			sizeOnDisk: chain.size_on_disk,
			connections: info.connections,
			tlsConnections: info.tls_established,
			networkHashps: mining.networkhashps,
			stakingSupply: mining.stakingsupply,
			staking: mining.staking,
			mining: mining.generate,
			mempoolTxs: mempool.size,
			mempoolBytes: mempool.bytes,
			warnings: info.errors || network.warnings || '',
		}
		state.peers = peers.map((peer) => ({
			id: peer.id,
			addr: peer.addr,
			subver: peer.subver,
			inbound: peer.inbound,
			tls: peer.tls_established,
			height: Math.max(peer.synced_blocks ?? -1, peer.startingheight ?? -1),
			pingMs: typeof peer.pingtime === 'number' ? Math.round(peer.pingtime * 1000) : null,
			connectedAt: peer.conntime,
		}))
		if (state.phase === 'bootstrapping') await finishBootstrap()
		state.phase = 'running'
		state.message = synced ? 'Synchronized' : 'Synchronizing'
		state.rpcStatus = null
		state.error = null
		state.updatedAt = Date.now()
	} catch (error) {
		// -28 is "still warming up"; its message says what verusd is doing (loading block index, etc).
		if (state.phase === 'stopping') return
		if (error.code === -28) {
			state.rpcStatus = error.message
			if (state.phase !== 'bootstrapping') state.phase = 'starting'
			state.message = error.message
		} else if (state.phase === 'running') {
			state.rpcStatus = error.message
		}
	}
}

// ---------------------------------------------------------------------------
// PBaaS chains

const chains = createChains({
	home: HOME,
	verusdBin: config.verusdBin,
	extraArgs: config.pbaasExtraArgs,
	log,
	root: () => ({
		running: state.phase === 'running' && !!state.node,
		synced: state.phase === 'running' && !!state.node?.synced,
		blocks: state.node?.blocks || 0,
		rpc,
	}),
})

// ---------------------------------------------------------------------------
// Electrum server

async function electrumFetch(pathname) {
	const response = await fetch(`${config.electrumUrl}${pathname}`, {signal: AbortSignal.timeout(5000)})
	if (!response.ok) throw new Error(`HTTP ${response.status}`)
	return response.json()
}

async function pollElectrum() {
	try {
		const status = await electrumFetch('/api/status')
		state.electrum = {
			phase: status.phase,
			message: status.message,
			error: status.error,
			dbHeight: status.dbHeight,
			daemonHeight: status.daemonHeight,
			progress: status.progress,
			sessions: status.sessions,
			version: status.version,
			host: status.connect?.host || config.deviceDomainName,
			port: status.connect?.port,
			protocol: status.connect?.protocol || 'tcp',
		}
	} catch {
		state.electrum = {phase: 'offline', message: 'The Electrum server is not running.'}
	}
}

async function widgetElectrum() {
	try {
		return await electrumFetch('/api/widget/sync')
	} catch {
		return {type: 'text-with-progress', refresh: '5s', link: '', title: 'Electrum server', text: '-', progressLabel: 'Offline', progress: 0}
	}
}

// ---------------------------------------------------------------------------
// HTTP

const PUBLIC_DIR = path.join(__dirname, 'public')
const MIME = {
	'.html': 'text/html; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.svg': 'image/svg+xml',
}

function sendJson(response, status, payload) {
	const body = JSON.stringify(payload)
	response.writeHead(status, {'content-type': 'application/json', 'cache-control': 'no-store'})
	response.end(body)
}

async function sendStatic(response, urlPath) {
	const relative = urlPath === '/' ? 'index.html' : urlPath.slice(1)
	const file = path.join(PUBLIC_DIR, relative)
	if (!file.startsWith(PUBLIC_DIR + path.sep) || !MIME[path.extname(file)]) return sendJson(response, 404, {error: 'Not found'})
	try {
		const content = await fsp.readFile(file)
		response.writeHead(200, {'content-type': MIME[path.extname(file)], 'cache-control': 'no-cache'})
		response.end(content)
	} catch {
		sendJson(response, 404, {error: 'Not found'})
	}
}

async function tailLog(maxBytes = 48 * 1024) {
	const file = path.join(config.dataDir, 'debug.log')
	let handle
	try {
		handle = await fsp.open(file, 'r')
		const {size} = await handle.stat()
		const length = Math.min(size, maxBytes)
		const buffer = Buffer.alloc(length)
		await handle.read(buffer, 0, length, size - length)
		const lines = buffer.toString('utf8').split('\n')
		if (size > length) lines.shift() // drop the partial first line
		return lines.filter(Boolean).slice(-200)
	} catch {
		return []
	} finally {
		await handle?.close()
	}
}

function formatHashrate(hashps) {
	const units = ['H/s', 'kH/s', 'MH/s', 'GH/s', 'TH/s', 'PH/s']
	let value = Number(hashps) || 0
	let unit = 0
	while (value >= 1000 && unit < units.length - 1) {
		value /= 1000
		unit++
	}
	return {text: value >= 100 ? value.toFixed(0) : value.toFixed(1), subtext: units[unit]}
}

function formatBytes(bytes) {
	const units = ['B', 'KB', 'MB', 'GB', 'TB']
	let value = Number(bytes) || 0
	let unit = 0
	while (value >= 1000 && unit < units.length - 1) {
		value /= 1000
		unit++
	}
	return {text: value >= 100 || unit === 0 ? value.toFixed(0) : value.toFixed(1), subtext: units[unit]}
}

function widgetStats() {
	const node = state.node
	const hashrate = formatHashrate(node?.networkHashps)
	const size = formatBytes(node?.sizeOnDisk)
	return {
		type: 'four-stats',
		refresh: '5s',
		link: '',
		items: [
			{title: 'Connections', text: node ? String(node.connections) : '-', subtext: 'peers'},
			{title: 'Mempool', text: node ? String(node.mempoolTxs) : '-', subtext: 'txs'},
			{title: 'Hashrate', text: node ? hashrate.text : '-', subtext: hashrate.subtext},
			{title: 'Blockchain size', text: node ? size.text : '-', subtext: size.subtext},
		],
	}
}

function widgetSync() {
	const node = state.node
	if (!node) {
		return {
			type: 'text-with-progress',
			refresh: '2s',
			link: '',
			title: 'Blockchain sync',
			text: '-',
			progressLabel: state.phase === 'params' ? 'Downloading parameters' : 'Starting',
			progress: 0,
		}
	}
	// Don't round up to 100% until the node really is at the tip.
	const percent = node.synced ? 100 : Math.min(Math.floor(node.progress * 1000) / 10, 99.9)
	return {
		type: 'text-with-progress',
		refresh: '2s',
		link: '',
		title: 'Blockchain sync',
		text: `${percent}%`,
		progressLabel: node.synced ? 'Synchronized' : 'In progress',
		progress: node.synced ? 1 : node.progress,
	}
}

function connectDetails() {
	return {
		rpc: {host: config.deviceDomainName, port: config.rpcPort, username: config.rpcUser, password: config.rpcPass},
		p2p: {host: config.deviceDomainName, port: config.p2pPort},
	}
}

// State-changing requests must come from our own page: browsers can't send a JSON content type
// cross-origin without a preflight, and the Origin header has to match the host we were reached on.
function isSameOrigin(request) {
	if (!(request.headers['content-type'] || '').startsWith('application/json')) return false
	const origin = request.headers.origin
	if (!origin) return true
	try {
		return new URL(origin).host === request.headers.host
	} catch {
		return false
	}
}

function readBody(request, limit = 4096) {
	return new Promise((resolve, reject) => {
		let data = ''
		request.setEncoding('utf8')
		request.on('data', (chunk) => {
			data += chunk
			if (data.length > limit) reject(new Error('Request too large'))
		})
		request.on('end', () => resolve(data))
		request.on('error', reject)
	})
}

const server = http.createServer(async (request, response) => {
	const {pathname} = new URL(request.url, 'http://localhost')
	try {
		if (request.method === 'GET') {
			if (pathname === '/api/status') {
				return sendJson(response, 200, {...state, chains: chains.list(), payoutAddress: chains.payoutAddress()})
			}
			if (pathname === '/api/chains') return sendJson(response, 200, {chains: chains.list(), payoutAddress: chains.payoutAddress()})
			const chainLog = /^\/api\/chains\/([A-Za-z0-9]+)\/logs$/.exec(pathname)
			if (chainLog) {
				const lines = await chains.logs(chainLog[1])
				return lines ? sendJson(response, 200, {lines}) : sendJson(response, 404, {error: 'Unknown chain'})
			}
			if (pathname === '/api/connect') return sendJson(response, 200, connectDetails())
			if (pathname === '/api/logs') return sendJson(response, 200, {lines: await tailLog()})
			if (pathname === '/api/widget/stats') return sendJson(response, 200, widgetStats())
			if (pathname === '/api/widget/sync') return sendJson(response, 200, widgetSync())
			if (config.electrumUrl) {
				if (pathname === '/api/widget/electrum') return sendJson(response, 200, await widgetElectrum())
				if (pathname === '/api/electrum/logs') {
					return sendJson(response, 200, await electrumFetch('/api/logs').catch(() => ({lines: []})))
				}
			}
			if (pathname.startsWith('/api/')) return sendJson(response, 404, {error: 'Not found'})
			return await sendStatic(response, pathname)
		}
		if (request.method === 'POST' && pathname === '/api/bootstrap') {
			if (!isSameOrigin(request)) return sendJson(response, 403, {error: 'Forbidden'})
			if (!['running', 'starting', 'stopped'].includes(state.phase)) {
				return sendJson(response, 409, {error: 'The node is busy. Try again in a moment.'})
			}
			await requestBootstrap()
			return sendJson(response, 202, {ok: true})
		}
		// Switch a PBaaS chain or its merge mining on or off: {"enabled": true} or {"mine": true}
		const chainPost = request.method === 'POST' && /^\/api\/chains\/([A-Za-z0-9]+)$/.exec(pathname)
		// Download and install a fresh bootstrap of a PBaaS chain
		// or delete the blockchain of a chain that is switched off
		const actionPost = request.method === 'POST' && /^\/api\/chains\/([A-Za-z0-9]+)\/(bootstrap|remove)$/.exec(pathname)
		if (actionPost) {
			if (!isSameOrigin(request)) return sendJson(response, 403, {error: 'Forbidden'})
			const result = actionPost[2] === 'bootstrap' ? await chains.requestBootstrap(actionPost[1]) : await chains.removeData(actionPost[1])
			if (result.error) return sendJson(response, result.status, {error: result.error})
			chains.tick()
			return sendJson(response, 200, {ok: true, chains: chains.list(), payoutAddress: chains.payoutAddress()})
		}
		if (chainPost || (request.method === 'POST' && pathname === '/api/payout')) {
			if (!isSameOrigin(request)) return sendJson(response, 403, {error: 'Forbidden'})
			let body
			try {
				body = JSON.parse(await readBody(request))
			} catch {
				return sendJson(response, 400, {error: 'Invalid request'})
			}
			if (!body || typeof body !== 'object') return sendJson(response, 400, {error: 'Invalid request'})
			const result = chainPost
				? await chains.setChain(chainPost[1], {enabled: body.enabled, mine: body.mine})
				: chains.setPayout(typeof body.address === 'string' ? body.address.trim() : null)
			if (result.error) return sendJson(response, result.status, {error: result.error})
			chains.tick()
			return sendJson(response, 200, {ok: true, chains: chains.list(), payoutAddress: chains.payoutAddress()})
		}
		sendJson(response, 405, {error: 'Method not allowed'})
	} catch (error) {
		log('Request failed:', error.message)
		sendJson(response, 500, {error: 'Internal error'})
	}
})

// ---------------------------------------------------------------------------
// Lifecycle

async function shutdown(signal) {
	if (shuttingDown) return
	shuttingDown = true
	log(`${signal} received, stopping verusd`)
	state.phase = 'stopping'
	state.message = 'Shutting down…'
	clearTimeout(restartTimer)
	clearInterval(pollTimer)
	clearInterval(chainsTimer)
	clearInterval(electrumTimer)
	server.close()
	server.closeAllConnections?.()
	// the chain daemons talk to verusd while they shut down, so they go first
	await chains.stopAll()
	await stopDaemon()
	process.exit(0)
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

async function main() {
	if (!config.rpcPass) {
		console.error('RPC_PASS is required')
		process.exit(1)
	}
	await chains.load()
	server.listen(config.httpPort, () => log(`Dashboard listening on :${config.httpPort}`))
	if (config.electrumUrl) {
		pollElectrum()
		electrumTimer = setInterval(pollElectrum, POLL_INTERVAL_MS)
	}
	await ensureParams()
	if (shuttingDown) return
	await startDaemon()
	pollTimer = setInterval(poll, POLL_INTERVAL_MS)
	chainsTimer = setInterval(() => chains.tick().catch((error) => log('PBaaS chains:', error.message)), POLL_INTERVAL_MS)
}

main().catch((error) => {
	console.error(error)
	process.exit(1)
})
