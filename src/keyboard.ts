const KEYS = [
  { label: 'ABC', characters: 'abc' },
  { label: 'DEF', characters: 'def' },
  { label: 'GHI', characters: 'ghi' },
  { label: 'JKL', characters: 'jkl' },
  { label: 'MNO', characters: 'mno' },
  { label: 'PQRS', characters: 'pqrs' },
  { label: 'TUV', characters: 'tuv' },
  { label: 'WXYZ', characters: 'wxyz' },
  { label: 'SPACE', characters: ' ' },
  { label: '.,?!', characters: '.,?!' },
  { label: '123', characters: '0123456789' },
] as const

export class GestureKeyboard {
  draft = ''
  private keyIndex = 0
  private pendingIndex: number | null = null

  move(delta: number) {
    this.commitPending()
    this.keyIndex = (this.keyIndex + delta + KEYS.length) % KEYS.length
  }

  tap() {
    const key = KEYS[this.keyIndex]
    if (key.characters === ' ') {
      this.commitPending()
      if (this.draft && !this.draft.endsWith(' ')) this.draft += ' '
      return false
    }
    this.pendingIndex = this.pendingIndex === null ? 0 : (this.pendingIndex + 1) % key.characters.length
    return true
  }

  commitPending() {
    if (this.pendingIndex === null) return false
    this.draft += KEYS[this.keyIndex].characters[this.pendingIndex]
    this.pendingIndex = null
    return true
  }

  backspace() {
    if (this.pendingIndex !== null) {
      this.pendingIndex = null
      return
    }
    this.draft = this.draft.slice(0, -1)
  }

  reset() {
    this.draft = ''
    this.keyIndex = 0
    this.pendingIndex = null
  }

  get keys() {
    return KEYS
  }

  get selectedKeyIndex() {
    return this.keyIndex
  }

  get selectedKey() {
    return KEYS[this.keyIndex]
  }

  get pendingCharacter() {
    return this.pendingIndex === null ? '' : KEYS[this.keyIndex].characters[this.pendingIndex]
  }

  get displayDraft() {
    return `${this.draft}${this.pendingCharacter}`
  }
}
