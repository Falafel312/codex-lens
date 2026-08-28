import jsQR from 'jsqr'
import {
  AudioInputSource,
  CreateStartUpPageContainer,
  EventSourceType,
  OsEventTypeList,
  RebuildPageContainer,
  TextContainerProperty,
  TextContainerUpgrade,
  waitForEvenAppBridge,
} from '@evenrealities/even_hub_sdk'
import { pcmFramesToWavBase64 } from './audio'
import {
  ChatMessage,
  CodexThread,
  SavedConnection,
  claimPairing,
  codexApi,
  currentRelay,
  parsePairingQr,
  useConnection,
} from './api'
import { GestureKeyboard } from './keyboard'

type Screen = 'boot' | 'setup' | 'threads' | 'chat' | 'compose' | 'recording' | 'sending' | 'error'

const statusElement = document.querySelector<HTMLElement>('#status')
const scanButton = document.querySelector<HTMLButtonElement>('#scan-qr')
const resetButton = document.querySelector<HTMLButtonElement>('#reset-pairing')
const scannerPanel = document.querySelector<HTMLElement>('#qr-scanner')
const scannerVideo = document.querySelector<HTMLVideoElement>('#qr-video')
const cancelScanButton = document.querySelector<HTMLButtonElement>('#cancel-scan')
const PAIRING_STORAGE_KEY = 'codex-lens-connection-v2'
const setPhoneStatus = (message: string) => {
  if (statusElement) statusElement.textContent = message
}

const bridge = await waitForEvenAppBridge()
const keyboard = new GestureKeyboard()

const headerContainer = () =>
  new TextContainerProperty({
    xPosition: 0,
    yPosition: 0,
    width: 576,
    height: 38,
    borderWidth: 0,
    borderColor: 5,
    paddingLength: 4,
    containerID: 1,
    containerName: 'header',
    content: 'CODEX LENS',
    isEventCapture: 0,
  })

const bodyContainer = () =>
  new TextContainerProperty({
    xPosition: 0,
    yPosition: 40,
    width: 576,
    height: 202,
    borderWidth: 0,
    borderColor: 5,
    paddingLength: 6,
    containerID: 2,
    containerName: 'body',
    content: 'Starting…',
    isEventCapture: 1,
  })

const footerContainer = () =>
  new TextContainerProperty({
    xPosition: 0,
    yPosition: 244,
    width: 576,
    height: 44,
    borderWidth: 0,
    borderColor: 5,
    paddingLength: 4,
    containerID: 3,
    containerName: 'footer',
    content: '',
    isEventCapture: 0,
  })

const created = await bridge.createStartUpPageContainer(
  new CreateStartUpPageContainer({
    containerTotalNum: 3,
    textObject: [headerContainer(), bodyContainer(), footerContainer()],
  }),
)

if (created !== 0) throw new Error(`G2 page creation failed (${created})`)

let screen: Screen = 'boot'
let layout: 'text' | 'qr' = 'text'
let threads: CodexThread[] = []
let selectedThreadIndex = 0
let currentThread: CodexThread | null = null
let messages: ChatMessage[] = []
let selectedMessageIndex = 0
let audioFrames: Uint8Array[] = []
let pairPollTimer: number | null = null
let lastInputSource = 'G2'
let ignoreClicksUntil = 0
let cleanedUp = false
let scannerStream: MediaStream | null = null

function short(text: string, limit = 245) {
  const normalized = text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}…`
}

async function ensureTextLayout() {
  if (layout === 'text') return
  await bridge.rebuildPageContainer(
    new RebuildPageContainer({
      containerTotalNum: 3,
      textObject: [headerContainer(), bodyContainer(), footerContainer()],
    }),
  )
  layout = 'text'
}

async function renderText(header: string, body: string, footer: string) {
  await ensureTextLayout()
  await Promise.all([
    bridge.textContainerUpgrade(
      new TextContainerUpgrade({ containerID: 1, containerName: 'header', content: short(header, 54) }),
    ),
    bridge.textContainerUpgrade(
      new TextContainerUpgrade({ containerID: 2, containerName: 'body', content: short(body, 420) }),
    ),
    bridge.textContainerUpgrade(
      new TextContainerUpgrade({ containerID: 3, containerName: 'footer', content: short(footer, 90) }),
    ),
  ])
}

function inputLabel() {
  return lastInputSource === 'R1' ? 'R1' : 'TEMPLE'
}

async function showThreads() {
  screen = 'threads'
  currentThread = null
  messages = []
  const entries = [{ title: '＋ NEW CHAT' }, ...threads]
  selectedThreadIndex = Math.max(0, Math.min(selectedThreadIndex, entries.length - 1))
  const first = Math.max(0, Math.min(selectedThreadIndex - 1, Math.max(0, entries.length - 4)))
  const body = entries
    .slice(first, first + 4)
    .map((entry, offset) => `${first + offset === selectedThreadIndex ? '›' : ' '} ${short(entry.title, 42)}`)
    .join('\n')
  await renderText('CODEX THREADS', body || 'No conversations yet.', `↕ choose  • tap open  • hold talk  • ${inputLabel()}`)
  setPhoneStatus(`Connected securely through ${currentRelay()}`)
  if (scanButton) scanButton.hidden = true
  if (resetButton) resetButton.hidden = false
}

async function loadThreads() {
  const response = await codexApi.listThreads()
  threads = response.threads
  selectedThreadIndex = 0
  await showThreads()
}

async function openSelectedThread() {
  if (selectedThreadIndex === 0) {
    const result = await codexApi.createThread()
    currentThread = result.thread
    threads.unshift(result.thread)
    messages = []
  } else {
    currentThread = threads[selectedThreadIndex - 1]
    const result = await codexApi.getThread(currentThread.id)
    messages = result.messages
  }
  selectedMessageIndex = Math.max(0, messages.length - 1)
  await showChat()
}

async function showChat() {
  screen = 'chat'
  if (!currentThread) return showThreads()
  if (messages.length === 0) {
    await renderText(short(currentThread.title, 48), 'No messages yet.\n\nTap to type or hold to talk.', `tap type  • hold talk  • double back  • ${inputLabel()}`)
    return
  }
  selectedMessageIndex = Math.max(0, Math.min(selectedMessageIndex, messages.length - 1))
  const message = messages[selectedMessageIndex]
  const role = message.role === 'assistant' ? 'CODEX' : 'YOU'
  await renderText(
    `${role}  ${selectedMessageIndex + 1}/${messages.length}`,
    short(message.text, 410),
    '↕ messages  • tap type  • hold talk  • double back',
  )
}

async function showCompose() {
  screen = 'compose'
  const draft = keyboard.draft || '…'
  await renderText(
    `TYPE  • ${keyboard.level.toUpperCase()}`,
    `${short(draft, 250)}\n\n${keyboard.selection}`,
    '↕ choose  • tap select  • double erase  • hold send',
  )
}

async function beginVoice() {
  if (!currentThread) {
    const result = await codexApi.createThread()
    currentThread = result.thread
    threads.unshift(result.thread)
    messages = []
  }
  screen = 'recording'
  audioFrames = []
  ignoreClicksUntil = Date.now() + 900
  await renderText('VOICE PROMPT', 'Listening…\n\nKeep holding. Release to send.', `MIC: G2  • ${inputLabel()}`)
  const opened = await bridge.audioControl(true, AudioInputSource.Glasses)
  if (!opened) throw new Error('The G2 microphone could not be opened.')
}

async function finishVoice() {
  if (screen !== 'recording' || !currentThread) return
  await bridge.audioControl(false)
  ignoreClicksUntil = Date.now() + 900
  if (audioFrames.length === 0) {
    await renderText('VOICE PROMPT', 'No audio was captured.', 'Hold again to retry  • double back')
    screen = 'chat'
    return
  }
  screen = 'sending'
  await renderText('CODEX', 'Sending voice prompt…', 'You can release the ring or temple.')
  const response = await codexApi.sendAudio(currentThread.id, pcmFramesToWavBase64(audioFrames))
  messages.push({ id: `voice-${Date.now()}`, role: 'user', text: 'Voice prompt' }, response.message)
  selectedMessageIndex = messages.length - 1
  await showChat()
}

async function sendDraft() {
  const text = keyboard.draft.trim()
  if (!text || !currentThread) return
  screen = 'sending'
  await renderText('CODEX', 'Thinking…', short(text, 100))
  const response = await codexApi.sendText(currentThread.id, text)
  messages.push({ id: `typed-${Date.now()}`, role: 'user', text }, response.message)
  keyboard.reset()
  selectedMessageIndex = messages.length - 1
  await showChat()
}

async function showSetup() {
  screen = 'setup'
  setPhoneStatus('Step 3: tap Scan companion QR. Allow camera access when Even asks.')
  if (scanButton) scanButton.hidden = false
  if (resetButton) resetButton.hidden = true
  await renderText(
    'CONNECT CODEX LENS',
    'Finish setup on your phone.\n\nTap Scan companion QR, allow camera access, and point the phone at the code shown on your PC.',
    'Keep Codex Lens Companion open',
  )
}

function stopLiveScanner() {
  scannerStream?.getTracks().forEach(track => track.stop())
  scannerStream = null
  if (scannerVideo) scannerVideo.srcObject = null
  if (scannerPanel) scannerPanel.hidden = true
}

async function decodeQrFromNativeCamera() {
  setPhoneStatus('Fill most of the camera view with the companion QR, keep it square, then capture.')
  const asset = await bridge.captureImageFromCamera()
  if (!asset) throw new Error('Camera scan cancelled. Tap Scan companion QR to try again.')
  const source = asset.base64.startsWith('data:')
    ? asset.base64
    : `data:${asset.mimeType || 'image/jpeg'};base64,${asset.base64}`
  const image = new Image()
  image.src = source
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve()
    image.onerror = () => reject(new Error('The camera image could not be opened.'))
  })
  const result = decodeQrFromCapturedImage(image)
  if (!result) {
    throw new Error('No QR code was found. Move closer so the QR nearly fills the camera square, avoid screen glare, and try again.')
  }
  return result
}

function decodeQrPixels(pixels: ImageData) {
  const direct = jsQR(pixels.data, pixels.width, pixels.height, { inversionAttempts: 'attemptBoth' })
  if (direct?.data) return direct.data

  const contrasted = new Uint8ClampedArray(pixels.data)
  for (let index = 0; index < contrasted.length; index += 4) {
    const luminance = Math.round(
      contrasted[index] * 0.2126 + contrasted[index + 1] * 0.7152 + contrasted[index + 2] * 0.0722,
    )
    const value = Math.max(0, Math.min(255, Math.round((luminance - 128) * 1.9 + 128)))
    contrasted[index] = value
    contrasted[index + 1] = value
    contrasted[index + 2] = value
    contrasted[index + 3] = 255
  }
  return jsQR(contrasted, pixels.width, pixels.height, { inversionAttempts: 'attemptBoth' })?.data || ''
}

function decodeQrFromCapturedImage(image: HTMLImageElement) {
  const sourceWidth = image.naturalWidth
  const sourceHeight = image.naturalHeight
  const shortestSide = Math.min(sourceWidth, sourceHeight)
  const crops = [
    { x: 0, y: 0, width: sourceWidth, height: sourceHeight },
    ...[1, 0.82, 0.66, 0.52].map(fraction => {
      const size = Math.max(1, Math.round(shortestSide * fraction))
      return {
        x: Math.round((sourceWidth - size) / 2),
        y: Math.round((sourceHeight - size) / 2),
        width: size,
        height: size,
      }
    }),
  ]

  for (const crop of crops) {
    for (const rotation of [0, 90, 180, 270]) {
      const maxSide = 1400
      const scale = Math.min(1, maxSide / Math.max(crop.width, crop.height))
      const drawnWidth = Math.max(1, Math.round(crop.width * scale))
      const drawnHeight = Math.max(1, Math.round(crop.height * scale))
      const sideways = rotation === 90 || rotation === 270
      const canvas = document.createElement('canvas')
      canvas.width = sideways ? drawnHeight : drawnWidth
      canvas.height = sideways ? drawnWidth : drawnHeight
      const context = canvas.getContext('2d', { willReadFrequently: true })
      if (!context) continue
      context.imageSmoothingEnabled = true
      context.imageSmoothingQuality = 'high'
      context.translate(canvas.width / 2, canvas.height / 2)
      context.rotate((rotation * Math.PI) / 180)
      context.drawImage(
        image,
        crop.x,
        crop.y,
        crop.width,
        crop.height,
        -drawnWidth / 2,
        -drawnHeight / 2,
        drawnWidth,
        drawnHeight,
      )
      context.setTransform(1, 0, 0, 1, 0, 0)
      const decoded = decodeQrPixels(context.getImageData(0, 0, canvas.width, canvas.height))
      if (decoded) return decoded
    }
  }
  return ''
}

async function decodeQrFromLiveCamera(): Promise<string | null> {
  if (!navigator.mediaDevices?.getUserMedia) {
    return null
  }
  if (!scannerVideo || !scannerPanel || !cancelScanButton) throw new Error('The live QR scanner could not start.')

  scannerPanel.hidden = false
  try {
    scannerStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
    })
  } catch (error) {
    scannerPanel.hidden = true
    console.warn('Live WebView camera is unavailable; using the Even native camera bridge.', error)
    return null
  }

  scannerVideo.srcObject = scannerStream
  await scannerVideo.play()
  const canvas = document.createElement('canvas')
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('The QR scanner is unavailable on this phone.')

  return new Promise<string>((resolve, reject) => {
    let timer = 0
    let finished = false
    const finish = (value?: string, error?: Error) => {
      if (finished) return
      finished = true
      window.clearTimeout(timer)
      cancelScanButton.removeEventListener('click', cancel)
      if (error) reject(error)
      else resolve(value || '')
    }
    const cancel = () => finish(undefined, new Error('QR scan cancelled.'))
    const startedAt = Date.now()
    const scanFrame = () => {
      if (finished) return
      if (Date.now() - startedAt > 90_000) {
        finish(undefined, new Error('No QR code was found. Keep the full companion QR inside the frame and try again.'))
        return
      }
      const sourceWidth = scannerVideo.videoWidth
      const sourceHeight = scannerVideo.videoHeight
      if (sourceWidth > 0 && sourceHeight > 0) {
        canvas.width = Math.min(sourceWidth, 960)
        canvas.height = Math.max(1, Math.round((sourceHeight / sourceWidth) * canvas.width))
        context.drawImage(scannerVideo, 0, 0, canvas.width, canvas.height)
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height)
        const result = jsQR(pixels.data, pixels.width, pixels.height, { inversionAttempts: 'attemptBoth' })
        if (result?.data) {
          finish(result.data)
          return
        }
      }
      timer = window.setTimeout(scanFrame, 120)
    }
    cancelScanButton.addEventListener('click', cancel)
    scanFrame()
  })
}

async function decodeQrFromPhoneCamera() {
  const liveResult = await decodeQrFromLiveCamera()
  if (liveResult) return liveResult
  stopLiveScanner()
  return decodeQrFromNativeCamera()
}

async function scanAndPair() {
  if (scanButton) scanButton.disabled = true
  setPhoneStatus('Opening QR scanner…')
  try {
    const qr = parsePairingQr(await decodeQrFromPhoneCamera())
    setPhoneStatus('Connecting securely…')
    const saved = await claimPairing(qr)
    await bridge.setLocalStorage(PAIRING_STORAGE_KEY, JSON.stringify(saved))
    await renderText('CONNECTED', 'Your Codex account is ready.', 'Loading conversations…')
    await loadThreads()
  } finally {
    stopLiveScanner()
    if (scanButton) scanButton.disabled = false
  }
}

async function showError(error: unknown) {
  console.error(error)
  screen = 'error'
  const message = error instanceof Error ? error.message : String(error)
  setPhoneStatus(message)
  await renderText('CONNECTION ERROR', short(message, 300), 'Double press to close and retry.')
}

function eventTypeOf(envelope?: { eventType?: OsEventTypeList }): OsEventTypeList | null {
  if (!envelope) return null
  return envelope.eventType ?? OsEventTypeList.CLICK_EVENT
}

function rememberInputSource(source?: EventSourceType) {
  if (source === EventSourceType.TOUCH_EVENT_FROM_RING) lastInputSource = 'R1'
  if (source === EventSourceType.TOUCH_EVENT_FROM_GLASSES_L || source === EventSourceType.TOUCH_EVENT_FROM_GLASSES_R) {
    lastInputSource = 'G2'
  }
}

async function onMove(delta: number) {
  if (screen === 'threads') {
    selectedThreadIndex += delta
    await showThreads()
  } else if (screen === 'chat') {
    selectedMessageIndex += delta
    await showChat()
  } else if (screen === 'compose') {
    keyboard.move(delta)
    await showCompose()
  }
}

async function onClick() {
  if (Date.now() < ignoreClicksUntil) return
  if (screen === 'threads') await openSelectedThread()
  else if (screen === 'chat') {
    keyboard.reset()
    await showCompose()
  } else if (screen === 'compose') {
    keyboard.select()
    await showCompose()
  }
}

async function onDoubleClick() {
  if (screen === 'threads' || screen === 'setup' || screen === 'error') {
    await bridge.shutDownPageContainer(1)
  } else if (screen === 'chat') {
    selectedThreadIndex = Math.max(0, threads.findIndex(thread => thread.id === currentThread?.id) + 1)
    await showThreads()
  } else if (screen === 'compose') {
    if (keyboard.draft || keyboard.level === 'character') {
      keyboard.backspace()
      await showCompose()
    } else {
      await showChat()
    }
  }
}

const unsubscribe = bridge.onEvenHubEvent(event => {
  if (screen === 'recording' && event.audioEvent?.audioPcm?.byteLength) {
    audioFrames.push(event.audioEvent.audioPcm)
  }

  rememberInputSource(event.sysEvent?.eventSource)
  const sysType = eventTypeOf(event.sysEvent)
  const textType = eventTypeOf(event.textEvent)
  const type = sysType ?? textType

  const run = async () => {
    if (type === OsEventTypeList.SYSTEM_EXIT_EVENT || type === OsEventTypeList.ABNORMAL_EXIT_EVENT) return cleanup()
    if (type === OsEventTypeList.LONG_PRESS_EVENT && ['threads', 'chat'].includes(screen)) return beginVoice()
    if (type === OsEventTypeList.LONG_PRESS_EVENT && screen === 'compose') return sendDraft()
    if (type === OsEventTypeList.LONG_PRESS_RELEASE_EVENT) return finishVoice()
    if (type === OsEventTypeList.DOUBLE_CLICK_EVENT) return onDoubleClick()
    if (type === OsEventTypeList.SCROLL_TOP_EVENT) return onMove(-1)
    if (type === OsEventTypeList.SCROLL_BOTTOM_EVENT) return onMove(1)
    if (type === OsEventTypeList.CLICK_EVENT) return onClick()
  }
  void run().catch(showError)
})

function cleanup() {
  if (cleanedUp) return
  cleanedUp = true
  stopLiveScanner()
  if (pairPollTimer !== null) window.clearInterval(pairPollTimer)
  bridge.audioControl(false)
  unsubscribe()
}

window.addEventListener('beforeunload', cleanup)

async function boot() {
  screen = 'boot'
  await renderText('CODEX LENS', 'Connecting securely…', 'Checking saved pairing')
  const serialized = await bridge.getLocalStorage(PAIRING_STORAGE_KEY).catch(() => '')
  if (serialized) {
    try {
      useConnection(JSON.parse(serialized) as SavedConnection)
      await loadThreads()
      return
    } catch {
      await bridge.setLocalStorage(PAIRING_STORAGE_KEY, '')
    }
  }
  await showSetup()
}

scanButton?.addEventListener('click', () => void scanAndPair().catch(showError))
resetButton?.addEventListener('click', () => {
  void bridge.setLocalStorage(PAIRING_STORAGE_KEY, '').then(showSetup).catch(showError)
})

void boot().catch(showError)
