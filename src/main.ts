import jsQR from 'jsqr'
import {
  AudioInputSource,
  EventSourceType,
  OsEventTypeList,
  waitForEvenAppBridge,
} from '@evenrealities/even_hub_sdk'
import { pcmFramesToWavBase64 } from './audio'
import {
  ChatMessage,
  CodexThread,
  SavedConnection,
  claimPairing,
  claimPairingCode,
  codexApi,
  currentRelay,
  parsePairingQr,
  useConnection,
} from './api'
import {
  GlassesDisplay,
  TEXT_SIZE_OPTIONS,
  cleanText,
  ellipsize,
  relativeTime,
  typography,
  wrapText,
  type TextSize,
} from './display'
import { GestureKeyboard } from './keyboard'

type Screen = 'boot' | 'setup' | 'threads' | 'settings' | 'chat' | 'compose' | 'recording' | 'sending' | 'error'

const statusElement = document.querySelector<HTMLElement>('#status')
const scanButton = document.querySelector<HTMLButtonElement>('#scan-qr')
const manualPairPanel = document.querySelector<HTMLElement>('#manual-pair')
const pairCodeInput = document.querySelector<HTMLInputElement>('#pair-code')
const pairCodeButton = document.querySelector<HTMLButtonElement>('#use-pair-code')
const resetButton = document.querySelector<HTMLButtonElement>('#reset-pairing')
const scannerPanel = document.querySelector<HTMLElement>('#qr-scanner')
const scannerVideo = document.querySelector<HTMLVideoElement>('#qr-video')
const cancelScanButton = document.querySelector<HTMLButtonElement>('#cancel-scan')
const PAIRING_STORAGE_KEY = 'codex-lens-connection-v2'
const SETTINGS_STORAGE_KEY = 'codex-lens-settings-v1'
const demoMode = import.meta.env.DEV && new URLSearchParams(location.search).has('demo')
const setPhoneStatus = (message: string) => {
  if (statusElement) statusElement.textContent = message
}

const bridge = await waitForEvenAppBridge()
const keyboard = new GestureKeyboard()
const display = new GlassesDisplay(bridge)
const created = await bridge.createStartUpPageContainer(display.startupPage())

if (created !== 0) throw new Error(`G2 page creation failed (${created})`)

let screen: Screen = 'boot'
let threads: CodexThread[] = []
let selectedThreadIndex = 0
let selectedSettingsIndex = 0
let currentThread: CodexThread | null = null
let messages: ChatMessage[] = []
let selectedMessageIndex = 0
let selectedMessagePage = 0
let textSize: TextSize = 'standard'
let audioFrames: Uint8Array[] = []
let pairPollTimer: number | null = null
let lastInputSource = 'G2'
let ignoreClicksUntil = 0
let cleanedUp = false
let scannerStream: MediaStream | null = null
let keyboardCommitTimer = 0
let eventQueue: Promise<void> = Promise.resolve()

function short(text: string, limit = 245) {
  const normalized = cleanText(text)
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}…`
}

function setFont(context: CanvasRenderingContext2D, size: number, weight: 400 | 600 | 700 = 400) {
  context.font = `${weight} ${size}px Arial, sans-serif`
}

function drawHeader(context: CanvasRenderingContext2D, title: string, meta = '') {
  const type = typography(textSize)
  context.fillStyle = '#b8b8b8'
  setFont(context, type.small, 700)
  context.fillText('CODEX LENS', 12, 8)
  context.fillStyle = '#ffffff'
  setFont(context, type.title, 700)
  context.fillText(ellipsize(context, title, meta ? 430 : 550), 12, 22)
  if (meta) {
    context.fillStyle = '#a8a8a8'
    setFont(context, type.small, 600)
    context.textAlign = 'right'
    context.fillText(meta, 564, 28)
    context.textAlign = 'left'
  }
  context.fillStyle = '#555555'
  context.fillRect(12, 49, 552, 1)
}

function drawFooter(context: CanvasRenderingContext2D, text: string) {
  const type = typography(textSize)
  context.fillStyle = '#555555'
  context.fillRect(12, 254, 552, 1)
  context.fillStyle = '#b8b8b8'
  setFont(context, type.small, 600)
  context.fillText(ellipsize(context, text, 552), 12, 265)
}

async function renderText(header: string, body: string, footer: string) {
  await display.render(context => {
    const type = typography(textSize)
    drawHeader(context, header)
    context.fillStyle = '#ffffff'
    setFont(context, type.body)
    const lines = wrapText(context, body, 552).slice(0, Math.max(1, Math.floor(190 / type.line)))
    lines.forEach((line, index) => context.fillText(line, 12, 62 + index * type.line))
    drawFooter(context, footer)
  })
}

function inputLabel() {
  return lastInputSource === 'R1' ? 'R1' : 'TEMPLE'
}

async function showThreads() {
  screen = 'threads'
  currentThread = null
  messages = []
  const entries = [
    { kind: 'new', title: 'New chat', preview: 'Start a fresh Codex task' },
    { kind: 'settings', title: 'Settings', preview: `Text size: ${textSize}` },
    ...threads.map(thread => ({ kind: 'thread', ...thread })),
  ]
  selectedThreadIndex = Math.max(0, Math.min(selectedThreadIndex, entries.length - 1))
  await display.render(context => {
    const type = typography(textSize)
    drawHeader(context, 'Chats', `${threads.length} recent`)
    const availableHeight = 194
    const visibleCount = Math.max(3, Math.floor(availableHeight / type.row))
    const first = Math.max(0, Math.min(selectedThreadIndex - 1, Math.max(0, entries.length - visibleCount)))
    entries.slice(first, first + visibleCount).forEach((entry, offset) => {
      const index = first + offset
      const selected = index === selectedThreadIndex
      const y = 55 + offset * type.row
      if (selected) {
        context.fillStyle = '#252525'
        context.fillRect(8, y - 2, 560, type.row - 3)
        context.strokeStyle = '#ffffff'
        context.lineWidth = 2
        context.strokeRect(8, y - 2, 560, type.row - 3)
      }
      context.fillStyle = selected ? '#ffffff' : '#d0d0d0'
      setFont(context, type.body, selected ? 700 : 600)
      const prefix = entry.kind === 'new' ? '＋ ' : entry.kind === 'settings' ? '⚙ ' : ''
      context.fillText(ellipsize(context, `${prefix}${entry.title}`, 455), 18, y + 2)
      if (entry.kind === 'thread') {
        context.fillStyle = '#8f8f8f'
        setFont(context, type.small, 600)
        context.textAlign = 'right'
        context.fillText(relativeTime('updatedAt' in entry ? entry.updatedAt : undefined), 556, y + 5)
        context.textAlign = 'left'
      }
      if (type.row >= 44) {
        context.fillStyle = '#888888'
        setFont(context, type.small)
        context.fillText(ellipsize(context, entry.preview || '', 525), 18, y + type.body + 7)
      }
    })
    drawFooter(context, `↕ Navigate   ● Open   Hold Voice   ${inputLabel()}`)
  })
  setPhoneStatus(`Connected securely through ${currentRelay()}`)
  if (scanButton) scanButton.hidden = true
  if (manualPairPanel) manualPairPanel.hidden = true
  if (resetButton) resetButton.hidden = false
}

function threadTimestamp(thread: CodexThread) {
  const value = thread.updatedAt
  if (typeof value === 'number') return value < 10_000_000_000 ? value * 1000 : value
  const parsed = value ? Date.parse(value) : 0
  return Number.isFinite(parsed) ? parsed : 0
}

async function loadThreads() {
  const response = await codexApi.listThreads()
  threads = [...response.threads].sort((left, right) => threadTimestamp(right) - threadTimestamp(left))
  selectedThreadIndex = threads.length ? 2 : 0
  await showThreads()
}

async function openSelectedThread() {
  if (selectedThreadIndex === 0) {
    const result = await codexApi.createThread()
    currentThread = result.thread
    threads.unshift(result.thread)
    messages = []
  } else if (selectedThreadIndex === 1) {
    await showSettings()
    return
  } else {
    currentThread = threads[selectedThreadIndex - 2]
    if (demoMode) {
      messages = [
        { id: 'demo-user', role: 'user', text: 'Redesign this interface so it feels calm, readable, and useful on smart glasses.' },
        {
          id: 'demo-codex',
          role: 'assistant',
          text: 'I would use the full display with clear hierarchy, generous spacing, visible navigation hints, and pagination that keeps every response readable. Compact mode can show more content, while Large mode prioritizes comfort.',
        },
      ]
    } else {
      const result = await codexApi.getThread(currentThread.id)
      messages = result.messages
    }
  }
  selectedMessageIndex = Math.max(0, messages.length - 1)
  selectedMessagePage = messagePages(messages[selectedMessageIndex]).length - 1
  await showChat()
}

function messagePages(message?: ChatMessage) {
  if (!message) return [['']]
  const canvas = document.createElement('canvas')
  const context = canvas.getContext('2d')
  if (!context) return [[short(message.text, 500)]]
  const type = typography(textSize)
  setFont(context, type.body)
  const lines = wrapText(context, message.text, 552)
  const linesPerPage = Math.max(3, Math.floor(180 / type.line))
  const pages: string[][] = []
  for (let index = 0; index < lines.length; index += linesPerPage) pages.push(lines.slice(index, index + linesPerPage))
  return pages.length ? pages : [['']]
}

async function showChat() {
  screen = 'chat'
  if (!currentThread) return showThreads()
  if (messages.length === 0) {
    await renderText(currentThread.title, 'No messages yet.\n\nTap to type or hold to talk.', `● Type   Hold Voice   ●● Back   ${inputLabel()}`)
    return
  }
  selectedMessageIndex = Math.max(0, Math.min(selectedMessageIndex, messages.length - 1))
  const message = messages[selectedMessageIndex]
  const pages = messagePages(message)
  selectedMessagePage = Math.max(0, Math.min(selectedMessagePage, pages.length - 1))
  const role = message.role === 'assistant' ? 'CODEX' : 'YOU'
  await display.render(context => {
    const type = typography(textSize)
    const pageMeta = pages.length > 1 ? ` • page ${selectedMessagePage + 1}/${pages.length}` : ''
    drawHeader(context, currentThread?.title || 'Chat', `${selectedMessageIndex + 1}/${messages.length}${pageMeta}`)
    context.fillStyle = message.role === 'assistant' ? '#ffffff' : '#a8a8a8'
    setFont(context, type.small, 700)
    context.fillText(role, 12, 59)
    context.fillStyle = '#ffffff'
    setFont(context, type.body)
    pages[selectedMessagePage].forEach((line, index) => context.fillText(line, 12, 79 + index * type.line))
    drawFooter(context, '↕ Read   ● Type   Hold Voice   ●● Chats')
  })
}

async function showCompose() {
  screen = 'compose'
  await display.render(context => {
    const type = typography(textSize)
    drawHeader(context, 'Compose', keyboard.pendingCharacter ? `Tap cycles: ${keyboard.selectedKey.label}` : 'Multi-tap keyboard')
    context.fillStyle = '#ffffff'
    setFont(context, type.body)
    const draft = keyboard.displayDraft || 'Start typing…'
    const lines = wrapText(context, draft, 552).slice(-Math.max(2, Math.floor(104 / type.line)))
    lines.forEach((line, index) => context.fillText(line, 12, 61 + index * type.line))

    const keys = keyboard.keys
    const visible = textSize === 'large' ? 3 : 5
    const half = Math.floor(visible / 2)
    const indices = Array.from({ length: visible }, (_, offset) => (keyboard.selectedKeyIndex - half + offset + keys.length) % keys.length)
    const gap = 6
    const width = Math.floor((552 - gap * (visible - 1)) / visible)
    indices.forEach((keyIndex, offset) => {
      const selected = keyIndex === keyboard.selectedKeyIndex
      const x = 12 + offset * (width + gap)
      const y = 179
      context.fillStyle = selected ? '#ffffff' : '#242424'
      context.fillRect(x, y, width, 52)
      context.strokeStyle = selected ? '#ffffff' : '#686868'
      context.lineWidth = selected ? 2 : 1
      context.strokeRect(x, y, width, 52)
      context.fillStyle = selected ? '#000000' : '#c0c0c0'
      setFont(context, selected ? type.body : type.small, selected ? 700 : 600)
      context.textAlign = 'center'
      context.fillText(keys[keyIndex].label, x + width / 2, y + (selected ? 14 : 17))
      context.textAlign = 'left'
    })
    drawFooter(context, '↕ Key   ● Cycle letter   ●● Delete   Hold Send')
  })
}

async function saveSettings() {
  await bridge.setLocalStorage(SETTINGS_STORAGE_KEY, JSON.stringify({ textSize }))
}

async function showSettings() {
  screen = 'settings'
  const items = [
    { title: 'Text size', value: textSize.toUpperCase() },
    { title: 'Display', value: '576×288 • 16 levels' },
    { title: 'Back to chats', value: '' },
  ]
  selectedSettingsIndex = Math.max(0, Math.min(selectedSettingsIndex, items.length - 1))
  await display.render(context => {
    const type = typography(textSize)
    drawHeader(context, 'Settings')
    items.forEach((item, index) => {
      const selected = index === selectedSettingsIndex
      const y = 62 + index * 58
      if (selected) {
        context.fillStyle = '#242424'
        context.fillRect(8, y - 5, 560, 48)
        context.strokeStyle = '#ffffff'
        context.lineWidth = 2
        context.strokeRect(8, y - 5, 560, 48)
      }
      context.fillStyle = selected ? '#ffffff' : '#c8c8c8'
      setFont(context, Math.min(type.body, 19), selected ? 700 : 600)
      context.fillText(item.title, 18, y + 4)
      context.fillStyle = '#9a9a9a'
      setFont(context, Math.min(type.small, 14), 600)
      context.textAlign = 'right'
      context.fillText(item.value, 554, y + 8)
      context.textAlign = 'left'
    })
    drawFooter(context, '↕ Navigate   ● Change/Open   ●● Chats')
  })
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
  window.clearTimeout(keyboardCommitTimer)
  keyboard.commitPending()
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
  setPhoneStatus('Scan the companion QR, or enter its one-time pair code below.')
  if (scanButton) scanButton.hidden = false
  if (manualPairPanel) manualPairPanel.hidden = false
  if (resetButton) resetButton.hidden = true
  await renderText(
    'CONNECT CODEX LENS',
    'Finish setup on your phone.\n\nScan the companion QR, or enter the one-time pair code shown on your PC.',
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

async function finishPairing(saved: SavedConnection) {
  await bridge.setLocalStorage(PAIRING_STORAGE_KEY, JSON.stringify(saved))
  await renderText('CONNECTED', 'Your Codex account is ready.', 'Loading conversations…')
  await loadThreads()
}

async function scanAndPair() {
  if (scanButton) scanButton.disabled = true
  setPhoneStatus('Opening QR scanner…')
  try {
    const qr = parsePairingQr(await decodeQrFromPhoneCamera())
    setPhoneStatus('Connecting securely…')
    await finishPairing(await claimPairing(qr))
  } finally {
    stopLiveScanner()
    if (scanButton) scanButton.disabled = false
  }
}

async function enterPairCode() {
  if (!pairCodeInput?.value) throw new Error('Enter the pair code shown by Codex Lens Companion.')
  if (pairCodeButton) pairCodeButton.disabled = true
  setPhoneStatus('Checking one-time pair code…')
  try {
    await finishPairing(await claimPairingCode(pairCodeInput.value))
    pairCodeInput.value = ''
  } finally {
    if (pairCodeButton) pairCodeButton.disabled = false
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
  } else if (screen === 'settings') {
    selectedSettingsIndex += delta
    await showSettings()
  } else if (screen === 'chat') {
    if (delta < 0) {
      if (selectedMessagePage > 0) selectedMessagePage -= 1
      else if (selectedMessageIndex > 0) {
        selectedMessageIndex -= 1
        selectedMessagePage = messagePages(messages[selectedMessageIndex]).length - 1
      }
    } else if (selectedMessagePage < messagePages(messages[selectedMessageIndex]).length - 1) {
      selectedMessagePage += 1
    } else if (selectedMessageIndex < messages.length - 1) {
      selectedMessageIndex += 1
      selectedMessagePage = 0
    }
    await showChat()
  } else if (screen === 'compose') {
    window.clearTimeout(keyboardCommitTimer)
    keyboard.move(delta)
    await showCompose()
  }
}

async function onClick() {
  if (Date.now() < ignoreClicksUntil) return
  if (screen === 'threads') await openSelectedThread()
  else if (screen === 'settings') {
    if (selectedSettingsIndex === 0) {
      const index = TEXT_SIZE_OPTIONS.indexOf(textSize)
      textSize = TEXT_SIZE_OPTIONS[(index + 1) % TEXT_SIZE_OPTIONS.length]
      await saveSettings()
      await showSettings()
    } else if (selectedSettingsIndex === 2) {
      await showThreads()
    }
  }
  else if (screen === 'chat') {
    keyboard.reset()
    await showCompose()
  } else if (screen === 'compose') {
    window.clearTimeout(keyboardCommitTimer)
    const hasPending = keyboard.tap()
    await showCompose()
    if (hasPending) {
      keyboardCommitTimer = window.setTimeout(() => {
        keyboard.commitPending()
        void showCompose().catch(showError)
      }, 750)
    }
  }
}

async function onDoubleClick() {
  if (screen === 'threads' || screen === 'setup' || screen === 'error') {
    await bridge.shutDownPageContainer(1)
  } else if (screen === 'settings') {
    await showThreads()
  } else if (screen === 'chat') {
    selectedThreadIndex = Math.max(0, threads.findIndex(thread => thread.id === currentThread?.id) + 2)
    await showThreads()
  } else if (screen === 'compose') {
    window.clearTimeout(keyboardCommitTimer)
    if (keyboard.draft || keyboard.pendingCharacter) {
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
  eventQueue = eventQueue.then(run).catch(showError)
})

function cleanup() {
  if (cleanedUp) return
  cleanedUp = true
  window.clearTimeout(keyboardCommitTimer)
  stopLiveScanner()
  if (pairPollTimer !== null) window.clearInterval(pairPollTimer)
  bridge.audioControl(false)
  unsubscribe()
}

window.addEventListener('beforeunload', cleanup)

async function boot() {
  screen = 'boot'
  const serializedSettings = await bridge.getLocalStorage(SETTINGS_STORAGE_KEY).catch(() => '')
  if (serializedSettings) {
    try {
      const saved = JSON.parse(serializedSettings) as { textSize?: TextSize }
      if (saved.textSize && TEXT_SIZE_OPTIONS.includes(saved.textSize)) textSize = saved.textSize
    } catch {
      await bridge.setLocalStorage(SETTINGS_STORAGE_KEY, '')
    }
  }
  await renderText('CODEX LENS', 'Connecting securely…', 'Checking saved pairing')
  if (demoMode) {
    threads = [
      { id: 'demo-1', title: 'G2 interface redesign', preview: 'Improve layout, keyboard, and settings', updatedAt: Date.now() },
      { id: 'demo-2', title: 'QR pairing improvements', preview: 'Camera decoding and onboarding', updatedAt: Date.now() - 3_600_000 },
      { id: 'demo-3', title: 'Companion deployment', preview: 'Host the Windows setup flow', updatedAt: Date.now() - 86_400_000 },
      { id: 'demo-4', title: 'Voice input architecture', preview: 'Use the G2 microphone securely', updatedAt: Date.now() - 172_800_000 },
    ]
    selectedThreadIndex = 2
    await showThreads()
    return
  }
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
pairCodeInput?.addEventListener('input', () => {
  const normalized = pairCodeInput.value.toUpperCase().replace(/[^A-Z2-9]/g, '').slice(0, 16)
  pairCodeInput.value = normalized.match(/.{1,4}/g)?.join('-') || normalized
})
pairCodeButton?.addEventListener('click', () => {
  void enterPairCode().catch(error => {
    setPhoneStatus(error instanceof Error ? error.message : String(error))
  })
})
resetButton?.addEventListener('click', () => {
  void bridge.setLocalStorage(PAIRING_STORAGE_KEY, '').then(showSetup).catch(showError)
})

void boot().catch(showError)
