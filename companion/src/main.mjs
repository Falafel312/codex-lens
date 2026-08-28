import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import QRCode from 'qrcode'
import WebSocket from 'ws'
import { CodexService } from './codex-service.mjs'

const RELAY_WS = process.env.CODEX_LENS_RELAY_WS || 'wss://codex-lens-production.up.railway.app/companion'
const RELAY_HTTPS = process.env.CODEX_LENS_RELAY_HTTPS || 'https://codex-lens-production.up.railway.app'
const deviceConfigPath = () => path.join(app.getPath('userData'), 'device.json')

let window
let appServer
let codexService
let relaySocket
let reconnectTimer
let device
let pairSecret
let accountIdentity = ''
let accountApproved = false
const sessionSecrets = new Map()
let login
let state = {
  codex: 'starting',
  relay: 'offline',
  account: null,
  accountApproved: false,
  qrDataUrl: '',
  pairCode: '',
  loginCode: '',
  loginUrl: '',
  error: '',
}

function randomToken(bytes = 24) {
  return randomBytes(bytes).toString('base64url')
}

function createPairCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  return [...randomBytes(16)].map(value => alphabet[value & 31]).join('')
}

function formatPairCode(value) {
  return value.match(/.{1,4}/g)?.join('-') || value
}

function argumentValue(name) {
  return process.argv.find(argument => argument.startsWith(`${name}=`))?.slice(name.length + 1) || ''
}

function hashSecret(secret) {
  return createHash('sha256').update(secret).digest('base64url')
}

function encryptionKey(secret) {
  return createHash('sha256').update(`codex-lens-e2ee-v1:${secret}`).digest()
}

function encryptJson(secret, value) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(secret), iv)
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
  return {
    iv: iv.toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
  }
}

function decryptJson(secret, envelope) {
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(secret), Buffer.from(envelope.iv, 'base64url'))
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'))
  return JSON.parse(
    Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, 'base64url')),
      decipher.final(),
    ]).toString('utf8'),
  )
}

function emitState(patch = {}) {
  state = { ...state, ...patch }
  window?.webContents.send('state:changed', state)
}

async function loadDevice() {
  try {
    return JSON.parse(await readFile(deviceConfigPath(), 'utf8'))
  } catch {
    const created = { id: randomToken(18), secret: randomToken(32) }
    await writeFile(deviceConfigPath(), JSON.stringify(created), { encoding: 'utf8', mode: 0o600 })
    return created
  }
}

function nativeCodexPath() {
  if (process.env.CODEX_LENS_CODEX_COMMAND) return process.env.CODEX_LENS_CODEX_COMMAND
  const target = process.arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc'
  const packageName = process.arch === 'arm64' ? 'codex-win32-arm64' : 'codex-win32-x64'
  const appRoot = app.getAppPath().replace(/app\.asar$/, 'app.asar.unpacked')
  const packaged = path.join(appRoot, 'node_modules', '@openai', packageName, 'vendor', target, 'bin', 'codex.exe')
  if (existsSync(packaged)) return packaged
  return 'codex'
}

async function loadAppServerClass() {
  const source = app.isPackaged
    ? path.join(process.resourcesPath, 'server', 'codex-app-server.mjs')
    : path.resolve(app.getAppPath(), '..', 'server', 'codex-app-server.mjs')
  return (await import(pathToFileURL(source).href)).CodexAppServer
}

async function refreshAccount({ approve = false } = {}) {
  try {
    const account = await codexService.account()
    const identity = account ? String(account.email || account.id || account.name || 'signed-in') : ''
    if (!account) accountApproved = false
    else if (approve) accountApproved = true
    else if (identity !== accountIdentity) accountApproved = false
    accountIdentity = identity
    emitState({
      account,
      accountApproved,
      codex: account ? (accountApproved ? 'ready' : 'awaiting-confirmation') : 'signed-out',
      error: '',
    })
  } catch (error) {
    accountApproved = false
    accountIdentity = ''
    emitState({ account: null, accountApproved: false, codex: 'error', error: error.message })
  }
}

async function startCodex() {
  const CodexAppServer = await loadAppServerClass()
  appServer = new CodexAppServer({ command: nativeCodexPath(), cwd: homedir() })
  appServer.on('account/login/completed', async result => {
    if (!result?.success) return emitState({ codex: 'signed-out', error: result?.error || 'Sign-in was not completed.' })
    const userStartedThisLogin = Boolean(login)
    login = null
    emitState({ loginCode: '', loginUrl: '' })
    await refreshAccount({ approve: userStartedThisLogin })
  })
  appServer.on('exit', error => emitState({ codex: 'error', error: error.message }))
  await appServer.start()
  codexService = new CodexService(appServer, homedir())
  await refreshAccount()
}

async function updatePairingQr() {
  pairSecret = createPairCode()
  const payload = JSON.stringify({
    version: 1,
    relay: RELAY_HTTPS,
    deviceId: device.id,
    pairSecret,
  })
  const qrDataUrl = await QRCode.toDataURL(payload, { width: 360, margin: 2, errorCorrectionLevel: 'M' })
  emitState({ qrDataUrl, pairCode: formatPairCode(pairSecret) })
}

function publishPairHash() {
  if (relaySocket?.readyState !== WebSocket.OPEN) return
  relaySocket.send(JSON.stringify({ type: 'pair-update', pairHash: hashSecret(pairSecret) }))
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer)
  reconnectTimer = setTimeout(() => connectRelay().catch(() => {}), 2500)
}

async function connectRelay() {
  clearTimeout(reconnectTimer)
  relaySocket?.removeAllListeners()
  relaySocket?.close()
  await updatePairingQr()
  emitState({ relay: 'connecting' })

  relaySocket = new WebSocket(RELAY_WS, {
    headers: {
      'x-device-id': device.id,
      'x-device-secret': device.secret,
      'x-pair-hash': hashSecret(pairSecret),
    },
    maxPayload: 14 * 1024 * 1024,
  })

  relaySocket.on('open', () => emitState({ relay: 'online', error: '' }))
  relaySocket.on('close', () => {
    emitState({ relay: 'offline' })
    scheduleReconnect()
  })
  relaySocket.on('error', error => emitState({ relay: 'offline', error: `Relay: ${error.message}` }))
  relaySocket.on('message', async raw => {
    let message
    try {
      message = JSON.parse(String(raw))
    } catch {
      return
    }
    if (message.type === 'paired' && message.sessionId) {
      sessionSecrets.set(message.sessionId, pairSecret)
      await updatePairingQr()
      publishPairHash()
      return
    }
    if (message.type !== 'request' || !message.id || !message.sessionId || !message.envelope) return
    try {
      if (!state.account || !state.accountApproved) throw new Error('Confirm your Codex account in the desktop companion first.')
      const secret = sessionSecrets.get(message.sessionId)
      if (!secret) throw new Error('This pairing is no longer active. Scan the current QR code again.')
      const request = decryptJson(secret, message.envelope)
      const payload = await codexService.handle(request)
      const envelope = encryptJson(secret, { ok: true, payload })
      relaySocket.send(JSON.stringify({ type: 'response', id: message.id, envelope }))
    } catch (error) {
      const secret = sessionSecrets.get(message.sessionId)
      if (secret) {
        const envelope = encryptJson(secret, { ok: false, error: error.message })
        relaySocket.send(JSON.stringify({ type: 'response', id: message.id, envelope }))
      } else {
        relaySocket.send(JSON.stringify({ type: 'response', id: message.id, protocolError: 'Pair again.' }))
      }
    }
  })
}

function createWindow() {
  window = new BrowserWindow({
    width: 920,
    height: 760,
    minWidth: 760,
    minHeight: 650,
    backgroundColor: '#0d1117',
    title: 'Codex Lens Companion',
    webPreferences: {
      preload: path.join(import.meta.dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  window.removeMenu()
  window.loadFile(path.join(import.meta.dirname, 'index.html'))
  const screenshotPath = process.env.CODEX_LENS_SCREENSHOT || argumentValue('--screenshot')
  if (screenshotPath) {
    window.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        const image = await window.webContents.capturePage()
        await writeFile(screenshotPath, image.toPNG())
        app.quit()
      }, 6000)
    })
  }
}

ipcMain.handle('state:get', () => state)
ipcMain.handle('account:sign-in', async () => {
  login = await codexService.beginLogin()
  emitState({
    codex: 'signing-in',
    loginCode: login.userCode || '',
    loginUrl: login.verificationUrl || '',
    error: '',
  })
  if (login.verificationUrl) await shell.openExternal(login.verificationUrl)
  return state
})
ipcMain.handle('account:approve', async () => {
  if (!state.account) throw new Error('Sign in to Codex first.')
  accountApproved = true
  emitState({ accountApproved: true, codex: 'ready', error: '' })
  return state
})
ipcMain.handle('account:sign-out', async () => {
  accountApproved = false
  accountIdentity = ''
  await codexService.logout()
  await refreshAccount()
  return state
})
ipcMain.handle('relay:retry', async () => {
  await connectRelay()
  return state
})

app.whenReady().then(async () => {
  device = await loadDevice()
  createWindow()
  try {
    await startCodex()
  } catch (error) {
    emitState({ codex: 'error', error: `Codex: ${error.message}` })
  }
  await connectRelay().catch(error => emitState({ relay: 'offline', error: `Relay: ${error.message}` }))
})

app.on('window-all-closed', () => app.quit())
app.on('before-quit', () => {
  clearTimeout(reconnectTimer)
  relaySocket?.close()
  appServer?.stop()
})
