import { createServer } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { WebSocketServer, WebSocket } from 'ws'

const PORT = Number(process.env.PORT || 8790)
const DOWNLOAD_URL = process.env.DOWNLOAD_URL || ''
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000
const REQUEST_TIMEOUT_MS = 5 * 60 * 1000
const MAX_BODY_BYTES = 14 * 1024 * 1024

const devices = new Map()
const sessions = new Map()
const pending = new Map()

const token = (bytes = 24) => randomBytes(bytes).toString('base64url')

function sendJson(response, status, value) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  })
  response.end(JSON.stringify(value))
}

function sendHtml(response, status, html) {
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'public, max-age=300',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  })
  response.end(html)
}

async function readJson(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('Request is too large')
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''))
  const b = Buffer.from(String(right || ''))
  return a.length === b.length && timingSafeEqual(a, b)
}

function sessionFrom(request) {
  const authorization = request.headers.authorization || ''
  const sessionToken = authorization.startsWith('Bearer ') ? authorization.slice(7) : ''
  const session = sessions.get(sessionToken)
  if (!session || session.expiresAt <= Date.now()) {
    if (sessionToken) sessions.delete(sessionToken)
    return null
  }
  return { ...session, token: sessionToken }
}

const home = () => `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Codex Lens</title><style>
body{margin:0;background:#0b0e13;color:#edf2f7;font:16px/1.55 system-ui,sans-serif}main{max-width:760px;margin:auto;padding:64px 24px}h1{font-size:48px;margin:0 0 8px}.tag{color:#8bb8ff;font-weight:700}.card{background:#151b25;border:1px solid #2b3546;border-radius:18px;padding:24px;margin:28px 0}li{margin:12px 0}a.button{display:inline-block;background:#e7ff69;color:#111;padding:13px 20px;border-radius:999px;text-decoration:none;font-weight:800}small,a{color:#a9b8ce}
</style><main><div class="tag">EVEN G2 + R1</div><h1>Codex Lens</h1><p>Use your own Codex chats from your glasses—by voice or ring and temple gestures.</p>
<div class="card"><h2>Set up in three steps</h2><ol><li>Install and open Codex Lens Companion on your Windows PC.</li><li>Sign into your own Codex account in the companion.</li><li>Open Codex Lens in Even Hub and scan the QR shown on your PC.</li></ol>
${DOWNLOAD_URL ? `<a class="button" href="${DOWNLOAD_URL}">Download for Windows</a>` : '<p><strong>The Windows download is being prepared.</strong></p>'}</div>
<p><small>Your OpenAI login stays on your PC. Prompts and responses are end-to-end encrypted between the Even app and your companion. The relay only routes encrypted data.</small></p>
<p><a href="/privacy">Privacy</a> · <a href="/support">Setup & support</a></p></main></html>`

const privacy = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Codex Lens Privacy</title><style>body{max-width:760px;margin:50px auto;padding:0 24px;background:#0b0e13;color:#edf2f7;font:16px/1.6 system-ui}a{color:#8bb8ff}</style><h1>Privacy</h1><p>Codex Lens Companion uses the Codex sign-in stored on your own computer. OpenAI credentials are never sent to the Codex Lens relay.</p><p>The QR code creates an end-to-end encrypted connection. The relay processes device identifiers, short-lived session identifiers, encrypted payloads, connection timing, and basic operational logs. It cannot decrypt prompt or conversation content.</p><p>No conversation database is maintained by the relay. Your Codex history remains in your own Codex account and local Codex installation.</p><p><a href="/">Back to setup</a></p>`

const support = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Codex Lens Setup</title><style>body{max-width:760px;margin:50px auto;padding:0 24px;background:#0b0e13;color:#edf2f7;font:16px/1.6 system-ui}li{margin:12px 0}a{color:#8bb8ff}</style><h1>Setup & support</h1><ol><li>Install Codex Lens Companion and leave it open.</li><li>Select <strong>Sign in to Codex</strong>. Your browser opens the official Codex sign-in page; enter the displayed code if asked.</li><li>Wait until both status lights say <strong>Ready</strong> and <strong>Online</strong>.</li><li>Open Codex Lens from the Even Hub app on your phone.</li><li>Tap <strong>Scan companion QR</strong>, take a clear photo of the QR on your PC, and approve pairing.</li><li>Put on your G2. Scroll to choose a chat, tap to open/type, or hold the R1/temple to speak.</li></ol><h2>If it does not connect</h2><p>Keep the companion running, confirm the PC has internet, then press Retry in the companion and scan the newest QR. Each QR can be used once.</p><p><a href="/">Back to download</a></p>`

const server = createServer(async (request, response) => {
  try {
    if (request.method === 'OPTIONS') return sendJson(response, 204, {})
    const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`)
    if (request.method === 'GET' && url.pathname === '/') return sendHtml(response, 200, home())
    if (request.method === 'GET' && url.pathname === '/privacy') return sendHtml(response, 200, privacy)
    if (request.method === 'GET' && url.pathname === '/support') return sendHtml(response, 200, support)
    if (request.method === 'GET' && url.pathname === '/health') {
      return sendJson(response, 200, { ok: true, connectedCompanions: devices.size })
    }

    if (request.method === 'POST' && url.pathname === '/v1/pair/claim') {
      const body = await readJson(request)
      const device = devices.get(body.deviceId)
      if (!device || device.socket.readyState !== WebSocket.OPEN || !safeEqual(device.pairHash, body.pairHash)) {
        return sendJson(response, 404, { message: 'This QR is invalid, expired, or the companion is offline.' })
      }
      const sessionId = token(18)
      const sessionToken = token(32)
      sessions.set(sessionToken, { id: sessionId, deviceId: body.deviceId, expiresAt: Date.now() + SESSION_TTL_MS })
      device.pairHash = ''
      device.socket.send(JSON.stringify({ type: 'paired', sessionId }))
      return sendJson(response, 200, { sessionToken, sessionId, expiresAt: Date.now() + SESSION_TTL_MS })
    }

    if (request.method === 'POST' && url.pathname === '/v1/proxy') {
      const session = sessionFrom(request)
      if (!session) return sendJson(response, 401, { message: 'Pair with the desktop companion again.' })
      const device = devices.get(session.deviceId)
      if (!device || device.socket.readyState !== WebSocket.OPEN) {
        return sendJson(response, 503, { message: 'The desktop companion is offline.' })
      }
      const body = await readJson(request)
      if (!body.envelope?.iv || !body.envelope?.ciphertext || !body.envelope?.tag) {
        return sendJson(response, 400, { message: 'Encrypted request required.' })
      }
      const requestId = token(18)
      const timer = setTimeout(() => {
        pending.delete(requestId)
        if (!response.writableEnded) sendJson(response, 504, { message: 'Codex took too long to respond.' })
      }, REQUEST_TIMEOUT_MS)
      pending.set(requestId, { response, timer, sessionId: session.id })
      device.socket.send(JSON.stringify({ type: 'request', id: requestId, sessionId: session.id, envelope: body.envelope }))
      return
    }

    sendJson(response, 404, { message: 'Not found' })
  } catch (error) {
    sendJson(response, error.message === 'Request is too large' ? 413 : 400, { message: error.message || 'Bad request' })
  }
})

const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_BODY_BYTES })

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`)
  if (url.pathname !== '/companion') return socket.destroy()
  const deviceId = String(request.headers['x-device-id'] || '')
  const deviceSecret = String(request.headers['x-device-secret'] || '')
  const pairHash = String(request.headers['x-pair-hash'] || '')
  if (!deviceId || !deviceSecret || !pairHash) return socket.destroy()
  const known = devices.get(deviceId)
  if (known && !safeEqual(known.secret, deviceSecret)) return socket.destroy()
  sockets.handleUpgrade(request, socket, head, ws => sockets.emit('connection', ws, { deviceId, deviceSecret, pairHash }))
})

sockets.on('connection', (socket, auth) => {
  devices.get(auth.deviceId)?.socket?.close(4001, 'Replaced by a new companion connection')
  const device = { socket, secret: auth.deviceSecret, pairHash: auth.pairHash }
  devices.set(auth.deviceId, device)

  socket.on('message', raw => {
    let message
    try { message = JSON.parse(String(raw)) } catch { return }
    if (message.type === 'pair-update' && typeof message.pairHash === 'string') {
      device.pairHash = message.pairHash
      return
    }
    if (message.type !== 'response' || !message.id) return
    const waiting = pending.get(message.id)
    if (!waiting) return
    pending.delete(message.id)
    clearTimeout(waiting.timer)
    if (message.protocolError) return sendJson(waiting.response, 409, { message: message.protocolError })
    sendJson(waiting.response, 200, { envelope: message.envelope })
  })

  socket.on('close', () => {
    if (devices.get(auth.deviceId)?.socket === socket) devices.delete(auth.deviceId)
  })
})

const cleanup = setInterval(() => {
  const now = Date.now()
  for (const [sessionToken, session] of sessions) if (session.expiresAt <= now) sessions.delete(sessionToken)
}, 60_000)
cleanup.unref()

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Codex Lens relay listening on ${PORT}`)
})

export { server }
