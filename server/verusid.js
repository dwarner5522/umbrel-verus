'use strict'

// Checks a VerusID signature over a file hash (the ".verusid" files published next to bootstrap
// archives) without a daemon of the chain it was made on. Bootstrap archives of a PBaaS chain are
// signed on that chain, so the VRSC daemon's verifyhash can't check them: it hashes in its own chain ID.
//
// A signature (version 1, VERSION_VERUSID) is: version (1 byte), block height (uint32 LE), then a
// compact-size count of 65-byte recoverable secp256k1 signatures. Each signs
//   sha256(prefix string || system ID || block height || identity ID || sha256 of the file)
// with prefix "Verus signed data:\n". The keys that signed are recovered from the signatures and must
// be enough of the identity's primary addresses (minimumsignatures).

const crypto = require('node:crypto')

const PREFIX = 'Verus signed data:\n'
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

// secp256k1
const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n
const G = [
	0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n,
	0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n,
]

const mod = (a, m = P) => ((a % m) + m) % m

function power(base, exponent, m = P) {
	let result = 1n
	base = mod(base, m)
	while (exponent > 0n) {
		if (exponent & 1n) result = (result * base) % m
		base = (base * base) % m
		exponent >>= 1n
	}
	return result
}

const inverse = (a, m = P) => power(a, m - 2n, m)

// Jacobian coordinates keep the scalar multiplications fast enough without a library.
function double([x, y, z]) {
	if (y === 0n) return [0n, 1n, 0n]
	const s = mod(4n * x * y * y)
	const m = mod(3n * x * x)
	const x3 = mod(m * m - 2n * s)
	return [x3, mod(m * (s - x3) - 8n * y * y * y * y), mod(2n * y * z)]
}

function add(a, b) {
	if (a[2] === 0n) return b
	if (b[2] === 0n) return a
	const z1z1 = mod(a[2] * a[2])
	const z2z2 = mod(b[2] * b[2])
	const u1 = mod(a[0] * z2z2)
	const u2 = mod(b[0] * z1z1)
	const s1 = mod(a[1] * b[2] * z2z2)
	const s2 = mod(b[1] * a[2] * z1z1)
	if (u1 === u2) return s1 === s2 ? double(a) : [0n, 1n, 0n]
	const h = mod(u2 - u1)
	const r = mod(s2 - s1)
	const hh = mod(h * h)
	const hhh = mod(h * hh)
	const x3 = mod(r * r - hhh - 2n * u1 * hh)
	return [x3, mod(r * (u1 * hh - x3) - s1 * hhh), mod(h * a[2] * b[2])]
}

function multiply(point, scalar) {
	let result = [0n, 1n, 0n]
	let addend = [point[0], point[1], 1n]
	while (scalar > 0n) {
		if (scalar & 1n) result = add(result, addend)
		addend = double(addend)
		scalar >>= 1n
	}
	return result
}

function affine([x, y, z]) {
	if (z === 0n) return null
	const zInverse = inverse(z)
	const zz = mod(zInverse * zInverse)
	return [mod(x * zz), mod(y * zz * zInverse)]
}

const toBigInt = (buffer) => BigInt(`0x${buffer.toString('hex') || '0'}`)
const toBuffer = (value, length) => Buffer.from(value.toString(16).padStart(length * 2, '0'), 'hex')
const sha256 = (data) => crypto.createHash('sha256').update(data).digest()
const hash160 = (data) => crypto.createHash('ripemd160').update(sha256(data)).digest()

// Returns the compressed or uncompressed public key that made a 65-byte compact signature, or null.
function recoverPublicKey(hash, signature) {
	if (signature.length !== 65) return null
	const header = signature[0]
	if (header < 27 || header > 34) return null
	const recovery = (header - 27) & 3
	const compressed = header - 27 >= 4
	const r = toBigInt(signature.subarray(1, 33))
	const s = toBigInt(signature.subarray(33, 65))
	if (r <= 0n || r >= N || s <= 0n || s >= N) return null

	const x = r + (recovery >= 2 ? N : 0n)
	if (x >= P) return null
	const alpha = mod(x * x * x + 7n)
	let y = power(alpha, (P + 1n) / 4n)
	if (mod(y * y) !== alpha) return null
	if ((y & 1n) !== BigInt(recovery & 1)) y = P - y

	const e = toBigInt(hash)
	const rInverse = inverse(r, N)
	// Q = r^-1 (sR - eG)
	const sR = multiply([x, y], s)
	const eG = multiply(G, mod(-e, N))
	const q = affine(multiply(affine(add(sR, eG)) || [0n, 0n], rInverse))
	if (!q) return null
	return compressed
		? Buffer.concat([Buffer.from([q[1] & 1n ? 3 : 2]), toBuffer(q[0], 32)])
		: Buffer.concat([Buffer.from([4]), toBuffer(q[0], 32), toBuffer(q[1], 32)])
}

function base58Decode(text) {
	let value = 0n
	for (const char of text) {
		const digit = BASE58.indexOf(char)
		if (digit < 0) throw new Error('Invalid base58')
		value = value * 58n + BigInt(digit)
	}
	const leadingZeros = text.length - text.replace(/^1+/, '').length
	const body = value === 0n ? Buffer.alloc(0) : toBuffer(value, Math.ceil(value.toString(16).length / 2))
	return Buffer.concat([Buffer.alloc(leadingZeros), body])
}

// The 20 bytes behind an i-address (identity, currency) or an R-address (key).
function addressHash(address) {
	const data = base58Decode(address)
	if (data.length !== 25 || !sha256(sha256(data.subarray(0, 21))).subarray(0, 4).equals(data.subarray(21))) {
		throw new Error(`Invalid address ${address}`)
	}
	return data.subarray(1, 21)
}

function compactSize(length) {
	if (length < 253) return Buffer.from([length])
	const buffer = Buffer.alloc(3)
	buffer[0] = 253
	buffer.writeUInt16LE(length, 1)
	return buffer
}

function parseSignature(base64) {
	const data = Buffer.from(base64, 'base64')
	if (data.length < 7 || data[0] !== 1) throw new Error('Unsupported signature version')
	const blockHeight = data.readUInt32LE(1)
	let offset = 5
	const count = data[offset++]
	const signatures = []
	for (let i = 0; i < count; i++) {
		const length = data[offset++]
		signatures.push(data.subarray(offset, offset + length))
		offset += length
	}
	if (offset !== data.length || !signatures.length) throw new Error('Malformed signature')
	return {blockHeight, signatures}
}

// fileHashHex: sha256 of the file as sha256sum prints it. systemId: i-address of the chain the
// signature was made on. identity: {identityaddress, primaryaddresses, minimumsignatures} as
// getidentity returns it. Returns true only when enough of the identity's keys signed.
function verifyFileSignature({fileHashHex, signature, systemId, identity}) {
	const {blockHeight, signatures} = parseSignature(signature)
	const height = Buffer.alloc(4)
	height.writeUInt32LE(blockHeight)
	const digest = sha256(
		Buffer.concat([
			compactSize(Buffer.byteLength(PREFIX)),
			Buffer.from(PREFIX),
			addressHash(systemId),
			height,
			addressHash(identity.identityaddress),
			Buffer.from(fileHashHex, 'hex'),
		]),
	)
	const keys = new Set((identity.primaryaddresses || []).map((address) => addressHash(address).toString('hex')))
	const signers = new Set()
	for (const one of signatures) {
		const publicKey = recoverPublicKey(digest, one)
		if (!publicKey) return false
		const id = hash160(publicKey).toString('hex')
		if (!keys.has(id)) return false
		signers.add(id)
	}
	return signers.size >= Math.max(Number(identity.minimumsignatures) || 1, 1)
}

module.exports = {verifyFileSignature, recoverPublicKey, parseSignature, addressHash, curve: {G, N, multiply, affine, mod, inverse}}
