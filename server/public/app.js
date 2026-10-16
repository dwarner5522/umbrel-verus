'use strict'

const $ = (id) => document.getElementById(id)
const number = new Intl.NumberFormat('en-US')

let password = ''
let revealed = false

function scale(value, units, base = 1000) {
	let unit = 0
	value = Number(value) || 0
	while (value >= base && unit < units.length - 1) {
		value /= base
		unit++
	}
	return {value: value >= 100 || unit === 0 ? value.toFixed(0) : value.toFixed(1), unit: units[unit]}
}

function ago(seconds) {
	if (seconds < 90) return {value: Math.max(Math.round(seconds), 0), unit: 'seconds ago'}
	if (seconds < 5400) return {value: Math.round(seconds / 60), unit: 'minutes ago'}
	if (seconds < 172800) return {value: Math.round(seconds / 3600), unit: 'hours ago'}
	if (seconds < 63072000) return {value: Math.round(seconds / 86400), unit: 'days ago'}
	return {value: (seconds / 31536000).toFixed(1), unit: 'years ago'}
}

function setPill(state, label) {
	$('status-pill').dataset.state = state
	$('status-pill').textContent = label
}

function setProgress(fraction) {
	const percent = Math.max(0, Math.min(fraction * 100, 100))
	$('sync-fill').style.width = `${percent}%`
	$('sync-bar').setAttribute('aria-valuenow', percent.toFixed(1))
}

function renderPeers(peers) {
	$('peer-count').textContent = peers.length ? `(${peers.length})` : ''
	const body = $('peers')
	body.replaceChildren()
	if (!peers.length) {
		const row = body.insertRow()
		const cell = row.insertCell()
		cell.colSpan = 5
		cell.className = 'empty'
		cell.textContent = 'No peers connected yet'
		return
	}
	for (const peer of peers) {
		const row = body.insertRow()
		// Peer-supplied strings (subver) are untrusted: text only, never HTML.
		row.insertCell().textContent = peer.addr
		row.insertCell().textContent = (peer.subver || '').replace(/^\/|\/$/g, '') || 'unknown'
		row.insertCell().textContent = `${peer.inbound ? 'Inbound' : 'Outbound'}${peer.tls ? ' · TLS' : ''}`
		const height = row.insertCell()
		height.className = 'num'
		height.textContent = peer.height >= 0 ? number.format(peer.height) : '–'
		const ping = row.insertCell()
		ping.className = 'num'
		ping.textContent = peer.pingMs == null ? '–' : `${peer.pingMs} ms`
	}
}

function renderNode(node) {
	// Never show 100% until the node is actually at the tip.
	const percent = node.synced ? 100 : Math.min(Math.floor(node.progress * 1000) / 10, 99.9)
	$('sync-percent').textContent = `${percent}%`
	$('sync-label').textContent = node.synced ? 'Synchronized' : 'Synchronizing'
	setProgress(node.synced ? 1 : node.progress)
	setPill(node.synced ? 'synced' : 'syncing', node.synced ? 'Synchronized' : 'Syncing')

	const target = Math.max(node.longestChain, node.headers, node.blocks)
	$('sync-message').textContent =
		node.longestChain > 0
			? `Block ${number.format(node.blocks)} of ${number.format(target)}`
			: `Block ${number.format(node.blocks)} · waiting for peers`

	$('version').textContent = `verusd ${node.version} · ${node.chain === 'main' ? 'mainnet' : node.chain}`
	$('stat-peers').textContent = number.format(node.connections)
	$('stat-mempool').textContent = number.format(node.mempoolTxs)

	const hashrate = scale(node.networkHashps, ['H/s', 'kH/s', 'MH/s', 'GH/s', 'TH/s', 'PH/s'])
	$('stat-hashrate').textContent = hashrate.value
	$('stat-hashrate-unit').textContent = hashrate.unit

	const size = scale(node.sizeOnDisk, ['B', 'KB', 'MB', 'GB', 'TB'])
	$('stat-size').textContent = size.value
	$('stat-size-unit').textContent = size.unit

	const staking = scale(node.stakingSupply, ['', 'K', 'M', 'B'])
	$('stat-staking').textContent = staking.value + staking.unit

	const tip = ago(Date.now() / 1000 - node.tipTime)
	$('stat-tip').textContent = tip.value
	$('stat-tip-unit').textContent = tip.unit
}

function renderWaiting(status) {
	for (const id of ['stat-peers', 'stat-mempool', 'stat-hashrate', 'stat-size', 'stat-staking', 'stat-tip']) $(id).textContent = '–'

	if (status.phase === 'params') {
		const {file, index, total, received, size} = status.params
		const fraction = size ? received / size : 0
		$('sync-percent').textContent = size ? `${Math.floor(fraction * 100)}%` : '–'
		$('sync-label').textContent = 'Downloading zk-SNARK parameters'
		setProgress(fraction)
		setPill('syncing', 'Preparing')
		const megabytes = (bytes) => number.format(Math.round(bytes / 1e6))
		$('sync-message').textContent = file
			? `File ${index + 1} of ${total}: ${file} (${megabytes(received)} of ${megabytes(size)} MB). One-time download.`
			: 'Checking parameters…'
		return
	}

	const labels = {
		starting: ['syncing', 'Starting', 'Starting'],
		bootstrapping: ['syncing', 'Bootstrapping', 'Loading bootstrap'],
		stopping: ['starting', 'Stopping', 'Stopping'],
		stopped: ['error', 'Stopped', 'Stopped'],
	}
	const [pill, pillLabel, label] = labels[status.phase] || ['starting', 'Starting', 'Starting']
	// While bootstrapping, verusd reports e.g. "Downloading Bootstrap......12.3456%"
	const percent = status.phase === 'bootstrapping' ? /([\d.]+)%/.exec(status.message || '')?.[1] : null
	$('sync-percent').textContent = percent ? `${Math.floor(percent)}%` : '–'
	$('sync-label').textContent = label
	setProgress(percent ? percent / 100 : 0)
	setPill(pill, pillLabel)
	$('sync-message').textContent = status.message || ''
}

function renderElectrum(electrum) {
	$('electrum').hidden = !electrum
	if (!electrum) return

	const ready = electrum.phase === 'ready'
	const known = electrum.dbHeight != null
	// Never show 100% until wallets can actually connect.
	const percent = ready ? 100 : Math.min(Math.floor((electrum.progress || 0) * 1000) / 10, 99.9)
	const labels = {ready: 'Ready for wallets', syncing: `Indexing ${percent}%`, offline: 'Offline', stopped: 'Stopped'}
	$('electrum-state').textContent = `· ${labels[electrum.phase] || 'Starting'}`
	$('electrum-fill').style.width = `${known ? percent : 0}%`
	$('electrum-bar').setAttribute('aria-valuenow', known ? percent : 0)

	const host = electrum.host || location.hostname
	$('electrum-host').textContent = host
	$('electrum-port').textContent = electrum.port ?? '–'
	$('electrum-protocol').textContent = (electrum.protocol || 'tcp').toUpperCase()
	$('electrum-server').textContent = electrum.port ? `${host}:${electrum.port}:${electrum.protocol || 'tcp'}` : '–'
	$('electrum-height').textContent =
		known && electrum.daemonHeight > 0 ? `${number.format(electrum.dbHeight)} of ${number.format(electrum.daemonHeight)} blocks` : '–'
	$('electrum-sessions').textContent = known ? number.format(electrum.sessions) : '–'

	$('electrum-hint').textContent =
		electrum.error ||
		(ready
			? 'Ready. In Verus Desktop or another lite wallet, add the server address below as a custom Electrum server for VRSC.'
			: electrum.phase === 'syncing'
				? 'Indexing the blockchain from your node. The first index takes several hours; wallets can connect once it has caught up.'
				: electrum.message || 'Starting…')
}

// ---------------------------------------------------------------------------
// PBaaS chains

let chainNames = ''

const size = (bytes) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`)

function chainStatus(chain) {
	if (chain.phase === 'off') return ['Off', '']
	const bootstrap = chain.bootstrap
	if (bootstrap) {
		if (bootstrap.stage === 'downloading' && bootstrap.total) {
			// never 100% until it is installed
			const percent = Math.min(Math.floor((bootstrap.received / bootstrap.total) * 1000) / 10, 99.9)
			return [`Bootstrap ${percent}%`, `${size(bootstrap.received)} of ${size(bootstrap.total)} downloaded`]
		}
		return bootstrap.stage === 'installing' ? ['Installing bootstrap', 'Checking the download and moving it into place'] : ['Bootstrap', 'Checking the signature']
	}
	if (chain.phase === 'held') return ['Not running', chain.message || '']
	if (chain.error) return ['Attention', chain.error]
	if (chain.bootstrapPending) return ['Bootstrap queued', chain.message || '']
	if (chain.phase !== 'running' || !chain.node) return [chain.phase === 'waiting' ? 'Waiting' : 'Starting', chain.message || '']
	const node = chain.node
	if (!node.synced) {
		// Never show 100% until the chain is actually at the tip.
		const percent = Math.min(Math.floor(node.progress * 1000) / 10, 99.9)
		return [node.longestChain > 0 ? `Syncing ${percent}%` : 'Waiting for peers', chain.mine ? 'Merge mining starts once it has synced' : '']
	}
	if (chain.mining) return ['Merge mining', '']
	return ['Synchronized', chain.mine ? 'Merge mining starts once VRSC has synced' : '']
}

function makeSwitch(name, key, label) {
	const button = document.createElement('button')
	button.type = 'button'
	button.className = 'switch'
	button.setAttribute('role', 'switch')
	button.setAttribute('aria-checked', 'false')
	button.setAttribute('aria-label', `${label} ${name}`)
	button.addEventListener('click', () => setChain(name, {[key]: button.getAttribute('aria-checked') !== 'true'}, button))
	return button
}

function renderChains(chains, payoutAddress) {
	const running = chains.filter((chain) => chain.enabled).length
	const mining = chains.filter((chain) => chain.mining).length
	$('chains-state').textContent = running ? `· ${running} on${mining ? `, ${mining} merge mining` : ''}` : ''
	$('payout-address').textContent = payoutAddress || 'not set'
	const input = $('payout-input')
	if (document.activeElement !== input && !input.value) input.placeholder = payoutAddress ? 'New R-address' : 'R-address'
	$('payout-save').textContent = payoutAddress ? 'Change' : 'Save'

	// Rows are only rebuilt when the list of chains changes, so the switches keep their focus.
	const body = $('chain-rows')
	const names = chains.map((chain) => chain.name).join(',')
	if (names !== chainNames) {
		chainNames = names
		body.replaceChildren()
		for (const chain of chains) {
			const row = body.insertRow()
			for (let cell = 0; cell < 5; cell++) row.insertCell()
			row.insertCell().append(makeSwitch(chain.name, 'enabled', 'Run'))
			row.insertCell().append(makeSwitch(chain.name, 'mine', 'Merge mine'))
			const button = document.createElement('button')
			button.type = 'button'
			button.className = 'copy'
			button.textContent = 'Bootstrap'
			button.addEventListener('click', () => bootstrapChain(chain.name, button))
			const remove = document.createElement('button')
			remove.type = 'button'
			remove.className = 'copy'
			remove.textContent = 'Remove data'
			remove.addEventListener('click', () => removeChainData(chain.name, remove))
			const actions = row.insertCell()
			actions.className = 'chain-actions'
			actions.append(button, remove)
		}
		if (!chains.length) {
			const cell = body.insertRow().insertCell()
			cell.colSpan = 8
			cell.className = 'empty'
			cell.textContent = 'No chains known yet'
		}
		const select = $('chain-log-select')
		const selected = select.value
		select.replaceChildren(...chains.map((chain) => new Option(chain.name, chain.name)))
		if (chains.some((chain) => chain.name === selected)) select.value = selected
	}
	chains.forEach((chain, index) => fillChainRow(body.rows[index], chain))
}

function fillChainRow(row, chain) {
	const [name, status, height, peers, found, run, mine, action] = row.cells
	name.className = 'chain-name'
	name.textContent = chain.name
	const [text, detail] = chainStatus(chain)
	status.className = 'chain-status'
	status.replaceChildren(text)
	if (detail) {
		const small = document.createElement('small')
		small.textContent = detail
		status.append(small)
	}
	height.className = peers.className = found.className = 'num'
	height.textContent = chain.node ? number.format(chain.node.blocks) : '–'
	peers.textContent = chain.node ? number.format(chain.node.connections) : '–'
	found.textContent = number.format(chain.foundCount)
	run.firstChild.setAttribute('aria-checked', String(!!chain.enabled))
	mine.firstChild.setAttribute('aria-checked', String(!!chain.mine))
	const [bootstrapButton, removeButton] = action.children
	bootstrapButton.disabled = !!chain.bootstrap || chain.bootstrapPending
	// only a chain that is switched off can have its blockchain deleted
	removeButton.hidden = chain.enabled || !chain.hasData
}

async function removeChainData(name, button) {
	const result = $('chains-result')
	if (!confirm(`Delete the downloaded ${name} blockchain to free its disk space? Switching ${name} on again starts with a new bootstrap.`)) return
	button.disabled = true
	try {
		const {chains, payoutAddress} = await post(`api/chains/${name}/remove`, {})
		result.hidden = true
		renderChains(chains, payoutAddress)
	} catch (error) {
		result.hidden = false
		result.textContent = error.message
	} finally {
		button.disabled = false
	}
}

async function bootstrapChain(name, button) {
	const result = $('chains-result')
	if (!confirm(`Replace the ${name} blockchain with the latest bootstrap from bootstrap.verus.expert? It is several gigabytes; it is checked against its signature before it is installed, and the chain is switched on for it.`)) return
	button.disabled = true
	try {
		const {chains, payoutAddress} = await post(`api/chains/${name}/bootstrap`, {})
		result.hidden = true
		renderChains(chains, payoutAddress)
	} catch (error) {
		result.hidden = false
		result.textContent = error.message
		button.disabled = false
	}
}

async function post(url, body) {
	const response = await fetch(url, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)})
	const result = await response.json().catch(() => ({}))
	if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`)
	return result
}

async function setChain(name, patch, button) {
	const result = $('chains-result')
	if (patch.enabled === false && !confirm(`Stop the ${name} chain? Merge mining it stops too. Its downloaded blockchain is kept.`)) return
	button.disabled = true
	try {
		const {chains, payoutAddress} = await post(`api/chains/${name}`, patch)
		result.hidden = true
		renderChains(chains, payoutAddress)
	} catch (error) {
		result.hidden = false
		result.textContent = error.message
	} finally {
		button.disabled = false
	}
}

$('payout-form').addEventListener('submit', async (event) => {
	event.preventDefault()
	const result = $('payout-result')
	const address = $('payout-input').value.trim()
	if (!address) return
	const current = $('payout-address').textContent
	if (current !== 'not set' && !confirm(`Pay merge-mined block rewards to ${address} instead of ${current}?`)) return
	result.hidden = false
	try {
		const {chains, payoutAddress} = await post('api/payout', {address})
		$('payout-input').value = ''
		result.textContent = 'Saved.'
		renderChains(chains, payoutAddress)
	} catch (error) {
		result.textContent = error.message
	}
})

async function refreshChainLog() {
	if (!$('chain-log-details').open || !$('chain-log-select').value) return
	try {
		const {lines} = await (await fetch(`api/chains/${$('chain-log-select').value}/logs`, {cache: 'no-store'})).json()
		const log = $('chain-log')
		const pinned = log.scrollTop + log.clientHeight >= log.scrollHeight - 24
		log.textContent = lines.length ? lines.join('\n') : 'The log is empty. It fills once the chain has been started.'
		if (pinned) log.scrollTop = log.scrollHeight
	} catch {
		// keep showing the last log we had
	}
}

async function refresh() {
	try {
		const response = await fetch('api/status', {cache: 'no-store'})
		if (!response.ok) throw new Error(`HTTP ${response.status}`)
		const status = await response.json()

		if (status.node) renderNode(status.node)
		else renderWaiting(status)
		renderPeers(status.peers || [])
		renderElectrum(status.electrum)
		renderChains(status.chains || [], status.payoutAddress || '')

		const error = status.error || status.node?.warnings
		$('error').hidden = !error
		$('error').textContent = error || ''
		if (status.error) setPill('error', 'Attention')

		$('bootstrap').disabled = !['running', 'starting', 'stopped'].includes(status.phase)
	} catch {
		setPill('error', 'Offline')
		$('sync-message').textContent = 'Cannot reach the app. Retrying…'
	}
}

async function refreshLog() {
	if (!$('log-details').open) return
	try {
		const {lines} = await (await fetch('api/logs', {cache: 'no-store'})).json()
		const log = $('log')
		const pinned = log.scrollTop + log.clientHeight >= log.scrollHeight - 24
		log.textContent = lines.length ? lines.join('\n') : 'The log is empty.'
		if (pinned) log.scrollTop = log.scrollHeight
	} catch {
		// keep showing the last log we had
	}
}

async function refreshElectrumLog() {
	if (!$('electrum-log-details').open) return
	try {
		const {lines} = await (await fetch('api/electrum/logs', {cache: 'no-store'})).json()
		const log = $('electrum-log')
		const pinned = log.scrollTop + log.clientHeight >= log.scrollHeight - 24
		log.textContent = lines.length ? lines.join('\n') : 'The log is empty.'
		if (pinned) log.scrollTop = log.scrollHeight
	} catch {
		// keep showing the last log we had
	}
}

async function loadConnect() {
	try {
		const details = await (await fetch('api/connect', {cache: 'no-store'})).json()
		password = details.rpc.password
		$('rpc-host').textContent = details.rpc.host || location.hostname
		$('rpc-port').textContent = details.rpc.port
		$('rpc-user').textContent = details.rpc.username
		$('p2p-port').textContent = details.p2p.port
	} catch {
		setTimeout(loadConnect, 5000)
	}
}

$('reveal').addEventListener('click', () => {
	revealed = !revealed
	$('rpc-pass').textContent = revealed ? password : '••••••••••••'
	$('reveal').textContent = revealed ? 'Hide' : 'Show'
})

async function copyText(text) {
	try {
		await navigator.clipboard.writeText(text)
		return true
	} catch {
		// The Clipboard API only exists in secure contexts, and Umbrel is usually opened over plain http.
		const field = document.createElement('textarea')
		field.value = text
		field.setAttribute('readonly', '')
		field.style.cssText = 'position:fixed;top:0;left:0;opacity:0'
		document.body.append(field)
		field.select()
		let copied = false
		try {
			copied = document.execCommand('copy')
		} catch {}
		field.remove()
		return copied
	}
}

for (const button of document.querySelectorAll('[data-copy]')) {
	button.addEventListener('click', async () => {
		const id = button.dataset.copy
		const text = id === 'rpc-pass' ? password : $(id).textContent
		if (await copyText(text)) {
			button.textContent = 'Copied'
		} else {
			// Last resort: reveal the value so it can be selected by hand.
			if (id === 'rpc-pass' && !revealed) $('reveal').click()
			button.textContent = 'Select to copy'
		}
		setTimeout(() => (button.textContent = 'Copy'), 2000)
	})
}

$('bootstrap').addEventListener('click', async () => {
	if (!confirm('Replace the downloaded blockchain data with the Verus bootstrap? Your wallet is kept.')) return
	const result = $('bootstrap-result')
	result.hidden = false
	try {
		const response = await fetch('api/bootstrap', {method: 'POST', headers: {'content-type': 'application/json'}, body: '{}'})
		const body = await response.json()
		result.textContent = response.ok ? 'Bootstrap started. This can take a while; progress appears in the node log.' : body.error
	} catch {
		result.textContent = 'Could not start the bootstrap. Try again.'
	}
	refresh()
})

$('log-details').addEventListener('toggle', refreshLog)
$('electrum-log-details').addEventListener('toggle', refreshElectrumLog)
$('chain-log-details').addEventListener('toggle', refreshChainLog)
$('chain-log-select').addEventListener('change', refreshChainLog)

loadConnect()
refresh()
setInterval(refresh, 3000)
setInterval(refreshLog, 5000)
setInterval(refreshElectrumLog, 5000)
setInterval(refreshChainLog, 5000)
