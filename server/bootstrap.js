'use strict'

// Downloads and installs the bootstrap archive of a PBaaS chain from bootstrap.verus.expert: a recent
// copy of its blockchain, so a chain starts close to the tip instead of verifying every block on the
// Umbrel. verusd 1.2.18 has a -bootstrap option for these chains too, but its download host no longer
// exists and it doesn't check a signature.
//
// Every archive comes with a ".verusid" file: its sha256, signed by the "Oink bootstrap releases@"
// VerusID. The signature is checked against that identity's keys as the VRSC daemon reports them, and
// the archive is only installed when its sha256 matches the signed one.

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const {spawn} = require('node:child_process')
const {verifyFileSignature} = require('./verusid')

const BOOTSTRAP_URL = process.env.PBAAS_BOOTSTRAP_URL || 'https://bootstrap.verus.expert'
const SIGNER = 'Oink bootstrap releases@'
const STAGING = '.bootstrap-staging'
// chain data a bootstrap replaces; the wallet and the conf file are kept
const REPLACED = ['blocks', 'chainstate', 'notarisations', 'komodostate', 'komodostate.ind', 'signedmasks', 'peers.dat', 'fee_estimates.dat']
const KEPT = new Set(['wallet.dat', 'debug.log', 'db.log', '.lock'])
const MAX_RESUMES = 30

// an abort signal that also fires after a timeout
function withTimeout(signal, ms) {
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(new Error('Timed out')), ms)
	const abort = () => controller.abort(signal.reason)
	if (signal.aborted) abort()
	else signal.addEventListener('abort', abort, {once: true})
	controller.signal.addEventListener('abort', () => clearTimeout(timer), {once: true})
	return controller.signal
}

const archiveUrl = (idHex) => `${BOOTSTRAP_URL}/${idHex}-bootstrap/${idHex}-bootstrap.tar.gz`

async function fetchJson(url, signal) {
	const response = await fetch(url, {signal: withTimeout(signal, 30_000)})
	if (!response.ok) {
		const error = new Error(`HTTP ${response.status} for ${url}`)
		error.status = response.status
		throw error
	}
	return response.json()
}

// The archive's size and signed hash, or null when there is no bootstrap for the chain.
async function bootstrapInfo(chain, signal = new AbortController().signal) {
	try {
		const signed = await fetchJson(`${archiveUrl(chain.idHex)}.verusid`, signal)
		const head = await fetch(archiveUrl(chain.idHex), {method: 'HEAD', signal: withTimeout(signal, 30_000)})
		if (!head.ok) return null
		return {size: Number(head.headers.get('content-length')) || 0, signed}
	} catch (error) {
		if (error.status === 404) return null
		throw error
	}
}

async function freeBytes(dir) {
	const stats = await fsp.statfs(dir)
	return stats.bavail * stats.bsize
}

// Links in the archive could point outside the chain's directory once it is moved into place.
async function findLink(dir) {
	for (const entry of await fsp.readdir(dir, {withFileTypes: true})) {
		const file = path.join(dir, entry.name)
		if (entry.isSymbolicLink()) return file
		if (entry.isDirectory()) {
			const found = await findLink(file)
			if (found) return found
		} else if (entry.isFile() && (await fsp.lstat(file)).nlink > 1) return file
	}
	return null
}

// Runs tar at low priority, fed the archive on stdin. Resolves when tar has written everything.
function startTar(lowPriority, target) {
	const args = ['-xzf', '-', '-C', target, '--no-same-owner', '--no-same-permissions']
	const tar = spawn(...lowPriority('tar', args), {stdio: ['pipe', 'ignore', 'pipe']})
	let stderr = ''
	tar.stderr.on('data', (chunk) => (stderr = (stderr + chunk).slice(-2000)))
	const done = new Promise((resolve, reject) => {
		tar.on('error', reject)
		tar.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`tar failed (${code}): ${stderr.trim().split('\n').pop() || 'no output'}`))))
	})
	done.catch(() => {})
	// tar exiting early shows up through `done`, not as a crash on the next write
	tar.stdin.on('error', () => {})
	return {tar, done}
}

// options: chain {name, id, idHex}, dir (the chain's data directory), rootRpc (VRSC daemon),
// lowPriority(command, args) -> [command, args], log, progress(update), signal
async function installBootstrap({chain, dir, rootRpc, lowPriority, log, progress, signal}) {
	progress({stage: 'checking', received: 0, total: 0})
	const info = await bootstrapInfo(chain, signal)
	if (!info) throw new Error(`There is no bootstrap for ${chain.name} on ${BOOTSTRAP_URL}`)

	const {signed, size} = info
	if (signed.signee !== SIGNER || !/^[0-9a-f]{64}$/.test(signed.hash || '') || typeof signed.signature !== 'string') {
		throw new Error('The bootstrap signature file is not from the expected signer')
	}
	const identity = (await rootRpc('getidentity', [SIGNER]))?.identity
	if (!identity) throw new Error(`The VRSC node does not know the ${SIGNER} identity`)
	if (!verifyFileSignature({fileHashHex: signed.hash, signature: signed.signature, systemId: chain.id, identity})) {
		throw new Error(`The bootstrap signature does not check out against ${SIGNER}. Not installing it.`)
	}
	log(`${chain.name} bootstrap: signed by ${SIGNER}, ${(size / 1e9).toFixed(1)} GB`)

	await fsp.mkdir(dir, {recursive: true})
	const staging = path.join(dir, STAGING)
	await fsp.rm(staging, {recursive: true, force: true})

	// the old chain data goes first, so the archive and the extracted copy have room
	for (const name of REPLACED) await fsp.rm(path.join(dir, name), {recursive: true, force: true})
	// the vDEX archive (5.9 GB) unpacks to 13 GB; leave room for that and some growth
	const needed = Math.ceil(size * 2.5) + 2e9
	const free = await freeBytes(dir)
	if (free < needed) {
		throw new Error(`Not enough free space for the ${chain.name} bootstrap: it needs about ${(needed / 1e9).toFixed(0)} GB, ${(free / 1e9).toFixed(0)} GB is free`)
	}
	await fsp.mkdir(staging)

	const hash = crypto.createHash('sha256')
	const {tar, done} = startTar(lowPriority, staging)
	let received = 0
	let lastReport = 0
	progress({stage: 'downloading', received, total: size})
	try {
		// a dropped connection carries on where it stopped: the hash and tar keep their state
		for (let attempt = 0; received < size; attempt++) {
			if (attempt > MAX_RESUMES) throw new Error('The download kept failing')
			if (attempt) await new Promise((resolve) => setTimeout(resolve, Math.min(attempt * 5000, 60_000)))
			signal.throwIfAborted()
			try {
				const response = await fetch(archiveUrl(chain.idHex), {
					headers: received ? {range: `bytes=${received}-`} : {},
					signal,
				})
				if (received ? response.status !== 206 : !response.ok) throw new Error(`HTTP ${response.status}`)
				for await (const chunk of response.body) {
					hash.update(chunk)
					received += chunk.length
					if (!tar.stdin.write(chunk)) await Promise.race([new Promise((resolve) => tar.stdin.once('drain', resolve)), done])
					if (Date.now() - lastReport > 1000) {
						lastReport = Date.now()
						progress({stage: 'downloading', received, total: size})
					}
				}
			} catch (error) {
				if (signal.aborted || tar.exitCode !== null) throw error
				log(`${chain.name} bootstrap: download interrupted at ${(received / 1e9).toFixed(2)} GB (${error.message}), resuming`)
			}
		}
		tar.stdin.end()
		progress({stage: 'installing', received, total: size})
		await done
	} catch (error) {
		tar.kill('SIGKILL')
		await fsp.rm(staging, {recursive: true, force: true})
		throw error
	}

	try {
		if (hash.digest('hex') !== signed.hash) throw new Error('The downloaded archive does not match the signed hash. Not installing it.')
		const link = await findLink(staging)
		if (link) throw new Error(`The archive contains a link (${path.relative(staging, link)}). Not installing it.`)
		const entries = await fsp.readdir(staging)
		if (!entries.includes('blocks') || !entries.includes('chainstate')) throw new Error('The archive has no blocks and chainstate folders')
		for (const name of entries) {
			if (KEPT.has(name) || name.endsWith('.conf')) continue
			await fsp.rm(path.join(dir, name), {recursive: true, force: true})
			await fsp.rename(path.join(staging, name), path.join(dir, name))
		}
	} finally {
		await fsp.rm(staging, {recursive: true, force: true})
	}
	log(`${chain.name} bootstrap installed`)
}

// A bootstrap interrupted by a restart is started again; the marker counts the attempts.
const markerFile = (dir) => path.join(dir, '.bootstrap-requested')

async function readMarker(dir) {
	try {
		return Number(await fsp.readFile(markerFile(dir), 'utf8')) || 0
	} catch {
		return null
	}
}

async function writeMarker(dir, attempts) {
	await fsp.mkdir(dir, {recursive: true})
	await fsp.writeFile(markerFile(dir), String(attempts))
}

const clearMarker = (dir) => fsp.rm(markerFile(dir), {force: true})

const hasChainData = (dir) => fs.existsSync(path.join(dir, 'blocks')) && fs.existsSync(path.join(dir, 'chainstate'))

module.exports = {installBootstrap, bootstrapInfo, readMarker, writeMarker, clearMarker, hasChainData, BOOTSTRAP_URL, SIGNER}
