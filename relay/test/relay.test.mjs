import test from 'node:test'
import assert from 'node:assert/strict'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import WebSocket from 'ws'

const base64url = value => Buffer.from(value).toString('base64url')
const pairHash = secret => createHash('sha256').update(secret).digest('base64url')
const key = secret => createHash('sha256').update(`codex-lens-e2ee-v1:${secret}`).digest()

function encrypt(secret, value) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key(secret), iv)
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()])
  return { iv: base64url(iv), ciphertext: base64url(ciphertext), tag: base64url(cipher.getAuthTag()) }
}

function decrypt(secret, envelope) {
  const decipher = createDecipheriv('aes-256-gcm', key(secret), Buffer.from(envelope.iv, 'base64url'))
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'))
  return JSON.parse(Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'base64url')),
    decipher.final(),
  ]).toString('utf8'))
}

test('pairs once and routes only encrypted Codex payloads', async () => {
  process.env.PORT = '0'
  const { server } = await import(`../src/server.mjs?test=${Date.now()}`)
  await new Promise(resolve => server.once('listening', resolve))
  const port = server.address().port
  const origin = `http://127.0.0.1:${port}`
  const secret = 'one-time-secret-that-stays-at-the-ends'
  const socket = new WebSocket(`ws://127.0.0.1:${port}/companion`, {
    headers: {
      'x-device-id': 'test-device',
      'x-device-secret': 'test-device-secret',
      'x-pair-hash': pairHash(secret),
    },
  })
  await new Promise((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })

  const paired = new Promise(resolve => socket.once('message', raw => resolve(JSON.parse(String(raw)))))
  const claim = await fetch(`${origin}/v1/pair/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId: 'test-device', pairHash: pairHash(secret) }),
  }).then(response => response.json())
  const pairedMessage = await paired
  assert.equal(pairedMessage.type, 'paired')
  assert.equal(pairedMessage.sessionId, claim.sessionId)

  const request = { method: 'POST', path: '/v1/threads/test/turns', body: { type: 'text', text: 'private prompt' } }
  const handled = new Promise((resolve, reject) => {
    socket.once('message', raw => {
      try {
        const message = JSON.parse(String(raw))
        assert.equal(String(raw).includes('private prompt'), false)
        assert.deepEqual(decrypt(secret, message.envelope), request)
        socket.send(JSON.stringify({
          type: 'response',
          id: message.id,
          envelope: encrypt(secret, { ok: true, payload: { message: { text: 'private response' } } }),
        }))
        resolve()
      } catch (error) { reject(error) }
    })
  })

  const responsePromise = fetch(`${origin}/v1/proxy`, {
    method: 'POST',
    headers: { authorization: `Bearer ${claim.sessionToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ envelope: encrypt(secret, request) }),
  }).then(response => response.json())
  await handled
  const proxied = await responsePromise
  assert.equal(JSON.stringify(proxied).includes('private response'), false)
  assert.equal(decrypt(secret, proxied.envelope).payload.message.text, 'private response')

  const reused = await fetch(`${origin}/v1/pair/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId: 'test-device', pairHash: pairHash(secret) }),
  })
  assert.equal(reused.status, 404)

  socket.close()
  await new Promise(resolve => server.close(resolve))
})
