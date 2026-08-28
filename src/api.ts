export type PairingQr = {
  version: 1
  relay: string
  deviceId: string
  pairSecret: string
}

export type SavedConnection = PairingQr & {
  sessionToken: string
  sessionId: string
}

export type CodexThread = { id: string; title: string; preview: string; updatedAt?: string | number }
export type ChatMessage = { id: string; role: 'user' | 'assistant'; text: string }

let connection: SavedConnection | null = null

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64UrlToBytes(value: string) {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')
  return Uint8Array.from(atob(padded), character => character.charCodeAt(0))
}

async function digest(value: string) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))
}

async function pairHash(secret: string) {
  return bytesToBase64Url(await digest(secret))
}

async function encryptionKey(secret: string) {
  return crypto.subtle.importKey(
    'raw',
    await digest(`codex-lens-e2ee-v1:${secret}`),
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt'],
  )
}

async function encrypt(secret: string, value: unknown) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, tagLength: 128 },
      await encryptionKey(secret),
      new TextEncoder().encode(JSON.stringify(value)),
    ),
  )
  return {
    iv: bytesToBase64Url(iv),
    ciphertext: bytesToBase64Url(encrypted.subarray(0, -16)),
    tag: bytesToBase64Url(encrypted.subarray(-16)),
  }
}

async function decrypt(secret: string, envelope: { iv: string; ciphertext: string; tag: string }) {
  const ciphertext = base64UrlToBytes(envelope.ciphertext)
  const tag = base64UrlToBytes(envelope.tag)
  const combined = new Uint8Array(ciphertext.length + tag.length)
  combined.set(ciphertext)
  combined.set(tag, ciphertext.length)
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64UrlToBytes(envelope.iv), tagLength: 128 },
    await encryptionKey(secret),
    combined,
  )
  return JSON.parse(new TextDecoder().decode(plain)) as { ok: boolean; payload?: unknown; error?: string }
}

async function jsonFetch<T>(url: string, init: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(url, init)
  } catch {
    throw new Error('Cannot reach Codex Lens. Check the internet connection and keep the desktop companion open.')
  }
  const body = (await response.json().catch(() => ({}))) as { message?: string }
  if (!response.ok) throw new Error(body.message || `Codex Lens request failed (${response.status})`)
  return body as T
}

export function parsePairingQr(value: string): PairingQr {
  const parsed = JSON.parse(value) as Partial<PairingQr>
  if (parsed.version !== 1 || !parsed.relay || !parsed.deviceId || !parsed.pairSecret) {
    throw new Error('That is not a Codex Lens Companion QR code.')
  }
  const relay = new URL(parsed.relay)
  if (relay.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(relay.hostname)) {
    throw new Error('The pairing service must use a secure HTTPS connection.')
  }
  return { version: 1, relay: relay.origin, deviceId: parsed.deviceId, pairSecret: parsed.pairSecret }
}

export async function claimPairing(qr: PairingQr): Promise<SavedConnection> {
  const result = await jsonFetch<{ sessionToken: string; sessionId: string }>(`${qr.relay}/v1/pair/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ deviceId: qr.deviceId, pairHash: await pairHash(qr.pairSecret) }),
  })
  connection = { ...qr, ...result }
  return connection
}

export function useConnection(saved: SavedConnection) {
  connection = saved
}

export function currentRelay() {
  return connection?.relay || 'not paired'
}

async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  if (!connection) throw new Error('Scan the QR code from Codex Lens Companion first.')
  const envelope = await encrypt(connection.pairSecret, { method, path, body })
  const result = await jsonFetch<{ envelope: { iv: string; ciphertext: string; tag: string } }>(
    `${connection.relay}/v1/proxy`,
    {
      method: 'POST',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${connection.sessionToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ envelope }),
    },
  )
  const decrypted = await decrypt(connection.pairSecret, result.envelope)
  if (!decrypted.ok) throw new Error(decrypted.error || 'The desktop companion could not complete the request.')
  return decrypted.payload as T
}

export const codexApi = {
  listThreads: () => request<{ threads: CodexThread[] }>('/v1/threads'),
  getThread: (id: string) => request<{ messages: ChatMessage[] }>(`/v1/threads/${encodeURIComponent(id)}`),
  createThread: () => request<{ thread: CodexThread }>('/v1/threads', 'POST'),
  sendText: (id: string, text: string) =>
    request<{ message: ChatMessage }>(`/v1/threads/${encodeURIComponent(id)}/turns`, 'POST', { type: 'text', text }),
  sendAudio: (id: string, wavBase64: string) =>
    request<{ message: ChatMessage }>(`/v1/threads/${encodeURIComponent(id)}/turns`, 'POST', {
      type: 'audio',
      audioBase64: wavBase64,
    }),
}
