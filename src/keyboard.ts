const GROUPS = [
  'abc',
  'def',
  'ghi',
  'jkl',
  'mno',
  'pqrs',
  'tuv',
  'wxyz',
  ' 0123456789',
  '.,?!-_/\'"',
]

export class GestureKeyboard {
  draft = ''
  private groupIndex = 0
  private characterIndex: number | null = null

  move(delta: number) {
    if (this.characterIndex === null) {
      this.groupIndex = (this.groupIndex + delta + GROUPS.length) % GROUPS.length
      return
    }
    const group = GROUPS[this.groupIndex]
    this.characterIndex = (this.characterIndex + delta + group.length) % group.length
  }

  select() {
    if (this.characterIndex === null) {
      this.characterIndex = 0
      return
    }
    this.draft += GROUPS[this.groupIndex][this.characterIndex]
    this.characterIndex = null
  }

  backspace() {
    if (this.characterIndex !== null) {
      this.characterIndex = null
      return
    }
    this.draft = this.draft.slice(0, -1)
  }

  reset() {
    this.draft = ''
    this.groupIndex = 0
    this.characterIndex = null
  }

  get selection() {
    const group = GROUPS[this.groupIndex]
    if (this.characterIndex === null) return `[ ${group.toUpperCase()} ]`
    return group
      .split('')
      .map((character, index) => (index === this.characterIndex ? `[${character === ' ' ? 'SPACE' : character}]` : character))
      .join('  ')
  }

  get level() {
    return this.characterIndex === null ? 'group' : 'character'
  }
}
