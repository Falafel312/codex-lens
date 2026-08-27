const SAMPLE_RATE = 16_000
const CHANNELS = 1
const BITS_PER_SAMPLE = 16

function writeAscii(view: DataView, offset: number, value: string) {
  for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i))
}

export function pcmFramesToWavBase64(frames: Uint8Array[]): string {
  const pcmLength = frames.reduce((total, frame) => total + frame.byteLength, 0)
  const wav = new Uint8Array(44 + pcmLength)
  const view = new DataView(wav.buffer)

  writeAscii(view, 0, 'RIFF')
  view.setUint32(4, 36 + pcmLength, true)
  writeAscii(view, 8, 'WAVE')
  writeAscii(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, CHANNELS, true)
  view.setUint32(24, SAMPLE_RATE, true)
  view.setUint32(28, (SAMPLE_RATE * CHANNELS * BITS_PER_SAMPLE) / 8, true)
  view.setUint16(32, (CHANNELS * BITS_PER_SAMPLE) / 8, true)
  view.setUint16(34, BITS_PER_SAMPLE, true)
  writeAscii(view, 36, 'data')
  view.setUint32(40, pcmLength, true)

  let offset = 44
  for (const frame of frames) {
    wav.set(frame, offset)
    offset += frame.byteLength
  }

  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < wav.length; i += chunkSize) {
    binary += String.fromCharCode(...wav.subarray(i, i + chunkSize))
  }
  return btoa(binary)
}
