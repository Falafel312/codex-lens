import {
  CreateStartUpPageContainer,
  ImageContainerProperty,
  ImageRawDataUpdate,
  TextContainerProperty,
  type EvenAppBridge,
} from '@evenrealities/even_hub_sdk'

export const DISPLAY_WIDTH = 576
export const DISPLAY_HEIGHT = 288
const TILE_WIDTH = 288
const TILE_HEIGHT = 144

export type TextSize = 'compact' | 'standard' | 'large'
export const TEXT_SIZE_OPTIONS: TextSize[] = ['compact', 'standard', 'large']

export const typography = (size: TextSize) => {
  if (size === 'compact') return { title: 17, body: 14, small: 11, line: 17, row: 38 }
  if (size === 'large') return { title: 24, body: 21, small: 15, line: 26, row: 62 }
  return { title: 20, body: 17, small: 13, line: 21, row: 48 }
}

const eventLayer = new TextContainerProperty({
  xPosition: 0,
  yPosition: 0,
  width: DISPLAY_WIDTH,
  height: DISPLAY_HEIGHT,
  borderWidth: 0,
  borderColor: 0,
  paddingLength: 0,
  containerID: 1,
  containerName: 'events',
  content: ' ',
  isEventCapture: 1,
  zOrderIndex: 1,
})

const tileSpecs = [
  { x: 0, y: 0, id: 2, name: 'tileTL', z: 2 },
  { x: TILE_WIDTH, y: 0, id: 3, name: 'tileTR', z: 3 },
  { x: 0, y: TILE_HEIGHT, id: 4, name: 'tileBL', z: 4 },
  { x: TILE_WIDTH, y: TILE_HEIGHT, id: 5, name: 'tileBR', z: 5 },
]

const imageTiles = tileSpecs.map(
  tile =>
    new ImageContainerProperty({
      xPosition: tile.x,
      yPosition: tile.y,
      width: TILE_WIDTH,
      height: TILE_HEIGHT,
      containerID: tile.id,
      containerName: tile.name,
      zOrderIndex: tile.z,
    }),
)

function bytesEqual(left: Uint8Array | undefined, right: Uint8Array) {
  if (!left || left.length !== right.length) return false
  for (let index = 0; index < right.length; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

function canvasGray8(context: CanvasRenderingContext2D) {
  const rgba = context.getImageData(0, 0, TILE_WIDTH, TILE_HEIGHT).data
  const gray = new Uint8Array(TILE_WIDTH * TILE_HEIGHT)
  for (let pixel = 0, offset = 0; pixel < gray.length; pixel += 1, offset += 4) {
    gray[pixel] = Math.round(rgba[offset] * 0.2126 + rgba[offset + 1] * 0.7152 + rgba[offset + 2] * 0.0722)
  }
  return gray
}

export class GlassesDisplay {
  private queue: Promise<void> = Promise.resolve()
  private latestFrame = 0
  private tileCache: Array<Uint8Array | undefined> = []

  constructor(private bridge: EvenAppBridge) {}

  startupPage() {
    return new CreateStartUpPageContainer({
      containerTotalNum: 5,
      textObject: [eventLayer],
      imageObject: imageTiles,
    })
  }

  async render(draw: (context: CanvasRenderingContext2D) => void) {
    const frame = ++this.latestFrame
    this.queue = this.queue.then(async () => {
      if (frame !== this.latestFrame) return
      const canvas = document.createElement('canvas')
      canvas.width = DISPLAY_WIDTH
      canvas.height = DISPLAY_HEIGHT
      const context = canvas.getContext('2d')
      if (!context) throw new Error('The G2 display renderer is unavailable.')
      context.fillStyle = '#000000'
      context.fillRect(0, 0, DISPLAY_WIDTH, DISPLAY_HEIGHT)
      context.textBaseline = 'top'
      draw(context)

      for (let index = 0; index < tileSpecs.length; index += 1) {
        if (frame !== this.latestFrame) return
        const spec = tileSpecs[index]
        const tile = document.createElement('canvas')
        tile.width = TILE_WIDTH
        tile.height = TILE_HEIGHT
        const tileContext = tile.getContext('2d')
        if (!tileContext) throw new Error('The G2 tile renderer is unavailable.')
        tileContext.drawImage(canvas, spec.x, spec.y, TILE_WIDTH, TILE_HEIGHT, 0, 0, TILE_WIDTH, TILE_HEIGHT)
        const bytes = canvasGray8(tileContext)
        if (bytesEqual(this.tileCache[index], bytes)) continue
        const result = await this.bridge.updateImageRawData(
          new ImageRawDataUpdate({
            containerID: spec.id,
            containerName: spec.name,
            imageData: bytes,
          }),
        )
        if (result !== 'success') throw new Error(`The G2 display update failed (${result}).`)
        this.tileCache[index] = bytes
      }
    })
    await this.queue
  }
}

export function cleanText(value: string) {
  return value.replace(/[\t ]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
}

export function ellipsize(context: CanvasRenderingContext2D, value: string, maxWidth: number) {
  const text = cleanText(value)
  if (context.measureText(text).width <= maxWidth) return text
  let result = text
  while (result.length > 1 && context.measureText(`${result}…`).width > maxWidth) result = result.slice(0, -1)
  return `${result}…`
}

export function wrapText(context: CanvasRenderingContext2D, value: string, maxWidth: number) {
  const lines: string[] = []
  for (const paragraph of cleanText(value).split('\n')) {
    if (!paragraph) {
      lines.push('')
      continue
    }
    const words = paragraph.split(' ')
    let line = ''
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word
      if (context.measureText(candidate).width <= maxWidth) {
        line = candidate
        continue
      }
      if (line) lines.push(line)
      if (context.measureText(word).width <= maxWidth) {
        line = word
        continue
      }
      let fragment = ''
      for (const character of word) {
        if (context.measureText(fragment + character).width > maxWidth && fragment) {
          lines.push(fragment)
          fragment = character
        } else {
          fragment += character
        }
      }
      line = fragment
    }
    if (line) lines.push(line)
  }
  return lines.length ? lines : ['']
}

export function relativeTime(value?: string | number) {
  if (value === undefined || value === null) return ''
  const parsed = typeof value === 'number' ? (value < 10_000_000_000 ? value * 1000 : value) : Date.parse(value)
  if (!Number.isFinite(parsed)) return ''
  const seconds = Math.max(0, Math.round((Date.now() - parsed) / 1000))
  if (seconds < 60) return 'now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  return days < 30 ? `${days}d` : `${Math.floor(days / 30)}mo`
}
