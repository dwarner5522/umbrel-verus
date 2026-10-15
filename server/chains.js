'use strict'

// Runs the PBaaS chain daemons (vARRR, vDEX, CHIPS, …) next to the VRSC daemon and switches merge
// mining on them. A PBaaS verusd that is mining hands each block it wants solved to the VRSC daemon
// over RPC ("addmergedblock"); the VRSC daemon puts it into the work it gives out, so whoever mines
// VRSC through this node mines those chains with the same hashes.

const http = require('node:http')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const readline = require('node:readline')
const {spawn} = require('node:child_process')
const bootstrap = require('./bootstrap')

const VRSC_ID = 'i5w5MuNik5NtLcYmNzcvaoixooEebB6MGV'

// Shown before the VRSC daemon can be asked which chains exist. idHex names the data directory.
const KNOWN_CHAINS = [
	{name: 'vARRR', id: 'iExBJfZYK7KREDpuhj6PzZBzqMAKaFg7d2', idHex: 'e9e10955b7d16031e3d6f55d9c908a038e3ae47d', blockTime: 60},
	{name: 'vDEX', id: 'iHog9UCTrn95qpUBFCZ7kKz7qWdMA8MQ6N', idHex: '53fe39eea8c06bba32f1a4e20db67e5524f0309d', blockTime: 60},
	{name: 'CHIPS', id: 'iJ3WZocnjG9ufv7GKUA4LijQno5gTMb7tP', idHex: 'f315367528394674d45277e369629605a1c3ce9f', blockTime: 10},
]

const RESTART_DELAY_MS = 15_000
const DISCOVERY_INTERVAL_MS = 10 * 60_000
const MAX_FOUND = 100
const SCAN_BLOCKS_PER_TICK = 10
// a chain daemon loading its block index takes a lot of CPU, so they start one after the other
const START_SPACING_MS = 60_000
const BOOTSTRAP_ATTEMPTS = 3
const BOOTSTRAP_RETRY_MS = 10 * 60_000
// how long merge mining stays off after the daemon was found hashing on the CPU itself
const HASHING_PAUSE_MS = 15 * 60_000

// The chain daemons run at a lower CPU and disk priority than everything else on the Umbrel, so
// a chain that is syncing slows down instead of the device. -t: carry on if the priority can't be set.
const NICE = ['/usr/bin/nice', '/bin/nice'].find((file) => fs.existsSync(file))
const IONICE = ['/usr/bin/ionice', '/bin/ionice'].find((file) => fs.existsSync(file))
function lowPriority(command, args) {
	let line = [command, ...args]
	if (NICE) line = [NICE, '-n', '15', ...line]
	if (IONICE) line = [IONICE, '-t', '-c', '2', '-n', '7', ...line]
	return [line[0], line.slice(1)]
}

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest()

// Transparent R-addresses only: they are valid on VRSC and on every PBaaS chain.
function isPayoutAddress(address) {
	if (typeof address !== 'string' || !/^R[1-9A-HJ-NP-Za-km-z]{33}$/.test(address)) return false
	let value = 0n
	for (const char of address) value = value * 58n + BigInt(BASE58.indexOf(char))
	const bytes = Buffer.from(value.toString(16).padStart(50, '0'), 'hex')
	if (bytes.length !== 25 || bytes[0] !== 60) return false
	return sha256(sha256(bytes.subarray(0, 21))).subarray(0, 4).equals(bytes.subarray(21))
}

function parseConf(text) {
	const conf = {}
	for (const line of text.split('\n')) {
		const match = /^\s*([a-z0-9_]+)\s*=\s*(.*?)\s*$/i.exec(line)
		if (match && !(match[1] in conf)) conf[match[1]] = match[2]
	}
	return conf
}

function rpcCall(target, method, params = []) {
	const body = JSON.stringify({jsonrpc: '1.0', id: 'umbrel', method, params})
	return new Promise((resolve, reject) => {
		const request = http.request(
			{
				host: '127.0.0.1',
				port: target.port,
				method: 'POST',
				auth: `${target.user}:${target.pass}`,
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

// A PBaaS daemon finds the VRSC daemon through VRSC.conf. verusd writes that file with random
// credentials on its first start, while this app passes the real ones on the command line, so
// make the file say the same thing. Every other line is kept.
async function writeRootConf(dataDir, {user, pass, port}) {
	const file = path.join(dataDir, 'VRSC.conf')
	const wanted = {rpcuser: user, rpcpassword: pass, rpcport: String(port), rpchost: '127.0.0.1'}
	let lines = []
	try {
		lines = (await fsp.readFile(file, 'utf8')).split('\n')
	} catch {}
	const current = parseConf(lines.join('\n'))
	if (Object.entries(wanted).every(([key, value]) => current[key] === value)) return
	const kept = lines.filter((line) => line.trim() && !(/^\s*([a-z0-9_]+)\s*=/i.exec(line)?.[1] in wanted))
	const content = [...Object.entries(wanted).map(([key, value]) => `${key}=${value}`), ...kept].join('\n') + '\n'
	await fsp.mkdir(dataDir, {recursive: true})
	const temporary = `${file}.tmp`
	await fsp.writeFile(temporary, content, {mode: 0o600})
	await fsp.rename(temporary, file)
}

// options: home, verusdBin, extraArgs, log, root() -> {running, synced, blocks, rpc(method, params)}
function createChains(options) {
	const {home, verusdBin, extraArgs, log, root} = options
	const settingsFile = path.join(home, 'pbaas-chains.json')
	const pbaasDir = path.join(home, '.verus', 'pbaas')

	const chains = new Map()
	let payoutAddress = ''
	let stopping = false
	let ticking = false
	let discoveredAt = 0
	let lastStartAt = 0
	let saveQueue = Promise.resolve()

	function addChain(definition) {
		const existing = chains.get(definition.name)
		if (existing) return Object.assign(existing, definition)
		const chain = {
			...definition,
			enabled: false,
			mine: false,
			found: [],
			phase: 'off',
			message: 'Off',
			error: null,
			node: null,
			mining: false,
			scanned: null,
			proc: null,
			rpc: null,
			restartAt: 0,
			lastOutput: '',
			// has reached the tip at least once: it doesn't have to wait for other chains to sync
			everSynced: false,
			// bootstrap: requested -> running (progress in `bootstrap`) -> done; held after it failed for good
			bootstrapRequested: false,
			bootstrapping: false,
			bootstrap: null,
			bootstrapAbort: null,
			held: false,
			hashing: 0,
			miningPausedUntil: 0,
			notice: null,
		}
		chains.set(definition.name, chain)
		return chain
	}

	function save() {
		const data = {payoutAddress, chains: {}}
		for (const chain of chains.values()) {
			data.chains[chain.name] = {
				id: chain.id,
				idHex: chain.idHex,
				blockTime: chain.blockTime,
				enabled: chain.enabled,
				mine: chain.mine,
				synced: chain.everSynced,
				found: chain.found,
			}
		}
		saveQueue = saveQueue
			.then(async () => {
				await fsp.writeFile(`${settingsFile}.tmp`, JSON.stringify(data, null, '\t'))
				await fsp.rename(`${settingsFile}.tmp`, settingsFile)
			})
			.catch((error) => log('Could not save the PBaaS chain settings:', error.message))
		return saveQueue
	}

	async function load() {
		for (const definition of KNOWN_CHAINS) addChain(definition)
		let saved
		try {
			saved = JSON.parse(await fsp.readFile(settingsFile, 'utf8'))
		} catch {
			return
		}
		if (isPayoutAddress(saved.payoutAddress)) payoutAddress = saved.payoutAddress
		for (const [name, entry] of Object.entries(saved.chains || {})) {
			if (!isChainName(name) || !entry) continue
			let chain = chains.get(name)
			// a chain found on the network earlier that is not in the built-in list
			if (!chain && /^[0-9a-f]{40}$/.test(entry.idHex || '')) {
				chain = addChain({name, id: String(entry.id || ''), idHex: entry.idHex, blockTime: Number(entry.blockTime) || 60})
			}
			if (!chain) continue
			chain.enabled = entry.enabled === true
			chain.mine = entry.mine === true
			chain.found = Array.isArray(entry.found) ? entry.found.slice(-MAX_FOUND) : []
			chain.everSynced = entry.synced === true
		}
		// a bootstrap that a restart interrupted starts again
		for (const chain of chains.values()) {
			if ((await bootstrap.readMarker(dataDir(chain))) !== null) chain.bootstrapRequested = true
		}
	}

	const isChainName = (name) => typeof name === 'string' && /^[A-Za-z0-9]{1,32}$/.test(name) && name.toUpperCase() !== 'VRSC'

	// Ask the VRSC daemon which PBaaS chains have launched, so new ones show up without an update.
	async function discover(rootState) {
		discoveredAt = Date.now()
		try {
			const currencies = await rootState.rpc('listcurrencies', [{systemtype: 'pbaas'}])
			let added = false
			for (const {currencydefinition: definition} of currencies || []) {
				if (!definition || !isChainName(definition.name)) continue
				if (definition.launchsystemid !== VRSC_ID || !/^[0-9a-f]{40}$/.test(definition.currencyidhex || '')) continue
				if (!(definition.startblock <= rootState.blocks)) continue
				if (!chains.has(definition.name)) added = true
				addChain({
					name: definition.name,
					id: definition.currencyid,
					idHex: definition.currencyidhex,
					blockTime: Number(definition.blocktime) || 60,
				})
			}
			if (added) save()
		} catch (error) {
			log('Could not list the PBaaS chains:', error.message)
		}
	}

	const dataDir = (chain) => path.join(pbaasDir, chain.idHex)

	async function readRpcTarget(chain) {
		try {
			const conf = parseConf(await fsp.readFile(path.join(dataDir(chain), `${chain.idHex}.conf`), 'utf8'))
			if (conf.rpcuser && conf.rpcpassword && Number(conf.rpcport) > 0) {
				return {user: conf.rpcuser, pass: conf.rpcpassword, port: Number(conf.rpcport)}
			}
		} catch {}
		return null
	}

	function start(chain) {
		if (stopping) return
		chain.phase = 'starting'
		chain.message = 'Starting…'
		chain.error = null
		chain.node = null
		chain.rpc = null
		chain.mining = false
		chain.scanned = null
		chain.lastOutput = ''

		log(`Starting verusd for ${chain.name}`)
		lastStartAt = Date.now()
		const proc = spawn(...lowPriority(verusdBin, [`-chain=${chain.name}`, '-showmetrics=0', ...extraArgs]), {
			env: {...process.env, HOME: home},
			stdio: ['ignore', 'pipe', 'pipe'],
		})
		chain.proc = proc
		for (const stream of [proc.stdout, proc.stderr]) {
			readline.createInterface({input: stream}).on('line', (line) => {
				if (!line.trim()) return
				chain.lastOutput = line.trim().slice(0, 300)
				log(`[${chain.name}] ${line}`)
			})
		}

		const ended = (reason, failed) => {
			if (chain.proc !== proc) return
			log(`verusd for ${chain.name} ${reason}`)
			chain.proc = null
			chain.rpc = null
			chain.node = null
			chain.mining = false
			if (stopping || !chain.enabled) {
				chain.phase = 'off'
				chain.message = 'Off'
				return
			}
			chain.phase = 'stopped'
			chain.message = 'Stopped. Restarting…'
			if (failed) chain.error = `The ${chain.name} daemon stopped unexpectedly${chain.lastOutput ? `: ${chain.lastOutput}` : '.'}`
			chain.restartAt = Date.now() + RESTART_DELAY_MS
		}
		// 'exit' is not emitted when the binary can't be spawned at all
		proc.on('error', (error) => ended(`could not be started: ${error.message}`, true))
		proc.on('exit', (code, signal) => ended(`exited (code=${code} signal=${signal})`, code !== 0))
	}

	function stop(chain) {
		return new Promise((resolve) => {
			const proc = chain.proc
			if (!proc) return resolve()
			chain.phase = 'stopping'
			chain.message = 'Stopping…'
			proc.once('exit', resolve)
			proc.once('error', resolve)
			proc.kill('SIGTERM')
		})
	}

	// Blocks this node's miners found pay the payout address in their coinbase.
	async function scanFound(chain, call) {
		if (chain.scanned === null) chain.scanned = chain.node.blocks
		let changed = false
		for (let count = 0; chain.scanned < chain.node.blocks && count < SCAN_BLOCKS_PER_TICK; count++) {
			const height = chain.scanned + 1
			const block = await call('getblock', [String(height)])
			const coinbase = await call('getrawtransaction', [block.tx[0], 1])
			let reward = 0
			for (const output of coinbase.vout || []) {
				if ((output.scriptPubKey?.addresses || []).includes(payoutAddress)) reward += Number(output.value) || 0
			}
			if (reward > 0) {
				log(`Found ${chain.name} block ${height} (${block.hash})`)
				chain.found.push({height, hash: block.hash, time: block.time * 1000, reward})
				chain.found = chain.found.slice(-MAX_FOUND)
				changed = true
			}
			chain.scanned = height
		}
		if (changed) save()
	}

	async function reconcileMining(chain, call, miningInfo, rootState) {
		// Merge mining only hands blocks to the VRSC daemon. A daemon that can't reach it mines on its
		// own instead, on the Umbrel's CPU: switch that off for a while rather than let it run.
		if (miningInfo.generate && Number(miningInfo.localhashps) > 0) chain.hashing++
		else chain.hashing = 0
		if (chain.hashing >= 2) {
			chain.hashing = 0
			chain.miningPausedUntil = Date.now() + HASHING_PAUSE_MS
			chain.notice = `${chain.name} was mining on the Umbrel's CPU instead of through VRSC, so merge mining is paused for 15 minutes.`
			log(chain.notice)
		}
		const paused = Date.now() < chain.miningPausedUntil
		if (!paused) chain.notice = null
		const want = chain.mine && !!payoutAddress && chain.node.synced && rootState.synced && !paused
		if (want) {
			const distribution = await call('getminingdistribution')
			const keys = distribution && typeof distribution === 'object' ? Object.keys(distribution) : []
			if (keys.length !== 1 || keys[0] !== payoutAddress) {
				await call('setminingdistribution', [{[payoutAddress]: 1}])
				log(`${chain.name} block rewards are paid to ${payoutAddress}`)
			}
			// One thread: it only hands the block to the VRSC daemon and waits, it does not hash.
			if (!miningInfo.generate) {
				await call('setgenerate', [true, 1])
				log(`Merge mining ${chain.name} switched on`)
			}
		} else if (miningInfo.generate) {
			await call('setgenerate', [false])
			log(`Merge mining ${chain.name} switched off`)
		}
		chain.mining = want
		if (want) await scanFound(chain, call).catch(() => {})
		else chain.scanned = null
	}

	async function poll(chain, rootState) {
		const proc = chain.proc
		if (!chain.rpc) chain.rpc = await readRpcTarget(chain)
		if (!chain.rpc) return
		const call = (method, params) => rpcCall(chain.rpc, method, params)
		try {
			const [info, miningInfo] = await Promise.all([call('getinfo'), call('getmininginfo')])
			if (chain.proc !== proc || chain.phase === 'stopping') return
			const target = Math.max(info.longestchain || 0, info.blocks || 0)
			const synced = info.longestchain > 0 && info.blocks >= info.longestchain
			chain.node = {
				blocks: info.blocks,
				longestChain: info.longestchain,
				progress: target > 0 ? Math.min(info.blocks / target, 1) : 0,
				synced,
				connections: info.connections,
				difficulty: info.difficulty,
				networkHashps: miningInfo.networkhashps,
				tipTime: info.tiptime,
			}
			chain.phase = 'running'
			chain.message = synced ? 'Synchronized' : 'Synchronizing'
			chain.error = null
			if (synced && !chain.everSynced) {
				chain.everSynced = true
				save()
			}
			await reconcileMining(chain, call, miningInfo, rootState)
		} catch (error) {
			if (chain.proc !== proc || chain.phase === 'stopping') return
			// -28 is "still warming up"; its message says what verusd is doing
			if (error.code === -28) {
				chain.phase = 'starting'
				chain.message = error.message
			} else if (chain.phase === 'running') {
				chain.message = `Not responding (${error.message})`
			}
		}
	}

	// Another chain that is downloading a bootstrap or syncing: only one does that at a time. Of the
	// chains still waiting for a bootstrap, the one listed first goes first.
	function busyChain(except) {
		let before = true
		for (const chain of chains.values()) {
			if (chain === except) {
				before = false
				continue
			}
			if (!chain.enabled || chain.held) continue
			// a bootstrap that failed and waits to be tried again doesn't hold the others up
			if (chain.bootstrapping || (before && chain.bootstrapRequested && Date.now() >= chain.restartAt)) return chain
			if (chain.proc && !chain.everSynced && !chain.node?.synced) return chain
		}
		return null
	}

	async function runBootstrap(chain, rootState) {
		const dir = dataDir(chain)
		const controller = new AbortController()
		chain.bootstrapping = true
		chain.bootstrapAbort = controller
		chain.error = null
		chain.phase = 'bootstrapping'
		chain.message = 'Checking the bootstrap…'
		const attempts = ((await bootstrap.readMarker(dir)) ?? 0) + 1
		try {
			await bootstrap.writeMarker(dir, attempts)
			await bootstrap.installBootstrap({
				chain,
				dir,
				rootRpc: rootState.rpc,
				lowPriority,
				log,
				signal: controller.signal,
				progress: (update) => (chain.bootstrap = update),
			})
			await bootstrap.clearMarker(dir)
			chain.bootstrapRequested = false
			chain.restartAt = 0
		} catch (error) {
			if (stopping) return // the marker stays: it starts again after the restart
			if (controller.signal.aborted) {
				// switched off while downloading
				await bootstrap.clearMarker(dir)
				chain.bootstrapRequested = false
				return
			}
			log(`${chain.name} bootstrap failed (attempt ${attempts}): ${error.message}`)
			if (/There is no bootstrap/.test(error.message)) {
				// nothing to download: sync from the network
				await bootstrap.clearMarker(dir)
				chain.bootstrapRequested = false
				chain.restartAt = 0
				return
			}
			chain.error = `Bootstrap failed: ${error.message}`
			if (attempts >= BOOTSTRAP_ATTEMPTS) {
				await bootstrap.clearMarker(dir)
				chain.bootstrapRequested = false
				chain.held = true
			} else {
				chain.restartAt = Date.now() + BOOTSTRAP_RETRY_MS
			}
		} finally {
			chain.bootstrapping = false
			chain.bootstrapAbort = null
			chain.bootstrap = null
		}
	}

	function waiting(chain, message) {
		chain.phase = 'waiting'
		chain.message = message
	}

	async function tickChain(chain, rootState) {
		if (!chain.enabled) {
			chain.bootstrapAbort?.abort()
			if (chain.proc && chain.phase !== 'stopping') stop(chain)
			return
		}
		if (chain.bootstrapping) return
		if (chain.held) {
			if (chain.proc && chain.phase !== 'stopping') stop(chain)
			return waiting(chain, 'Stopped. Press Bootstrap to try again, or switch the chain off.')
		}
		if (chain.bootstrapRequested) {
			if (chain.proc) {
				if (chain.phase !== 'stopping') stop(chain)
				return
			}
			// the signature check asks the VRSC daemon for the signer's keys
			if (!rootState.synced) return waiting(chain, 'Waiting for the VRSC node to finish syncing')
			const other = busyChain(chain)
			if (other) return waiting(chain, `Waiting for ${other.name} to finish syncing`)
			if (Date.now() < chain.restartAt) return waiting(chain, 'Trying the bootstrap again shortly')
			runBootstrap(chain, rootState).catch((error) => log(`${chain.name} bootstrap:`, error.message))
			return
		}
		if (!chain.proc) {
			// the daemon reads its chain definition from the VRSC daemon the first time it starts
			if (!rootState.synced) return waiting(chain, 'Waiting for the VRSC node to finish syncing')
			const other = !chain.everSynced && busyChain(chain)
			if (other) return waiting(chain, `Waiting for ${other.name} to finish syncing`)
			if (Date.now() < chain.restartAt) return
			if (Date.now() - lastStartAt < START_SPACING_MS) return waiting(chain, 'Starting shortly')
			await fsp.mkdir(pbaasDir, {recursive: true})
			start(chain)
			return
		}
		if (chain.phase !== 'stopping') await poll(chain, rootState)
	}

	async function tick() {
		if (ticking || stopping) return
		ticking = true
		try {
			const rootState = root()
			if (rootState.running && Date.now() - discoveredAt > DISCOVERY_INTERVAL_MS) await discover(rootState)
			// in list order, so the first chain waiting to sync is the next one to go
			for (const chain of chains.values()) await tickChain(chain, rootState)
		} finally {
			ticking = false
		}
	}

	function list() {
		return [...chains.values()].map((chain) => ({
			name: chain.name,
			id: chain.id,
			blockTime: chain.blockTime,
			enabled: chain.enabled,
			mine: chain.mine,
			phase: chain.enabled || chain.proc ? chain.phase : 'off',
			message: chain.enabled || chain.proc ? chain.message : 'Off',
			error: chain.enabled ? chain.error || chain.notice : null,
			bootstrap: chain.bootstrap,
			bootstrapPending: chain.bootstrapRequested && !chain.bootstrapping,
			node: chain.node,
			mining: chain.mining,
			foundCount: chain.found.length,
			found: chain.found.slice(-20),
		}))
	}

	// A chain switched on without any blockchain data starts from a bootstrap: syncing a chain from its
	// first block is what takes the most CPU and time.
	async function switchedOn(chain) {
		chain.held = false
		chain.error = null
		chain.restartAt = 0
		const dir = dataDir(chain)
		if (!chain.proc && !chain.bootstrapRequested && !bootstrap.hasChainData(dir)) {
			chain.bootstrapRequested = true
			await bootstrap.writeMarker(dir, 0)
		}
	}

	async function switchedOff(chain) {
		chain.held = false
		chain.error = null
		if (chain.bootstrapRequested && !chain.bootstrapping) {
			chain.bootstrapRequested = false
			await bootstrap.clearMarker(dataDir(chain))
		}
	}

	// patch: {enabled?: boolean, mine?: boolean}
	async function setChain(name, patch) {
		const chain = chains.get(name)
		if (!chain) return {status: 404, error: 'Unknown chain'}
		if (patch.enabled !== undefined && typeof patch.enabled !== 'boolean') return {status: 400, error: 'enabled must be true or false'}
		if (patch.mine !== undefined && typeof patch.mine !== 'boolean') return {status: 400, error: 'mine must be true or false'}
		if (patch.mine === true && !payoutAddress) {
			return {status: 409, error: 'Set a payout address first. Merge-mined rewards need somewhere to go.'}
		}
		const wasEnabled = chain.enabled
		if (patch.enabled !== undefined) chain.enabled = patch.enabled
		if (patch.mine !== undefined) chain.mine = patch.mine
		// merge mining needs the chain's own daemon
		if (patch.mine === true) chain.enabled = true
		if (patch.enabled === false) chain.mine = false
		if (chain.enabled && !wasEnabled) await switchedOn(chain)
		if (!chain.enabled && wasEnabled) await switchedOff(chain)
		save()
		return {status: 200}
	}

	// Replace the chain's blockchain with a fresh bootstrap. The chain is switched on for it.
	async function requestBootstrap(name) {
		const chain = chains.get(name)
		if (!chain) return {status: 404, error: 'Unknown chain'}
		if (chain.bootstrapping) return {status: 409, error: 'A bootstrap is already being downloaded.'}
		chain.enabled = true
		chain.held = false
		chain.error = null
		chain.restartAt = 0
		chain.bootstrapRequested = true
		await bootstrap.writeMarker(dataDir(chain), 0)
		save()
		return {status: 200}
	}

	function setPayout(address) {
		if (address !== '' && !isPayoutAddress(address)) {
			return {status: 400, error: 'That is not a valid Verus R-address.'}
		}
		payoutAddress = address
		if (!address) for (const chain of chains.values()) chain.mine = false
		save()
		return {status: 200}
	}

	async function logs(name, maxBytes = 48 * 1024) {
		const chain = chains.get(name)
		if (!chain) return null
		let handle
		try {
			handle = await fsp.open(path.join(dataDir(chain), 'debug.log'), 'r')
			const {size} = await handle.stat()
			const length = Math.min(size, maxBytes)
			const buffer = Buffer.alloc(length)
			await handle.read(buffer, 0, length, size - length)
			const lines = buffer.toString('utf8').split('\n')
			if (size > length) lines.shift()
			return lines.filter(Boolean).slice(-200)
		} catch {
			return []
		} finally {
			await handle?.close()
		}
	}

	async function stopAll() {
		stopping = true
		for (const chain of chains.values()) chain.bootstrapAbort?.abort()
		await Promise.all([...chains.values()].map(stop))
	}

	return {load, tick, list, setChain, requestBootstrap, setPayout, logs, stopAll, payoutAddress: () => payoutAddress}
}

module.exports = {createChains, writeRootConf, isPayoutAddress, parseConf, KNOWN_CHAINS}
