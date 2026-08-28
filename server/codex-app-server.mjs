import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

export class CodexAppServer extends EventEmitter {
  #child
  #nextId = 1
  #pending = new Map()
  #command
  #argsPrefix
  #cwd
  #env

  constructor({ command = 'codex', argsPrefix = [], cwd = process.cwd(), env = process.env } = {}) {
    super()
    this.#command = command
    this.#argsPrefix = argsPrefix
    this.#cwd = cwd
    this.#env = env
  }

  async start() {
    if (this.#child) return
    this.#child = spawn(this.#command, [...this.#argsPrefix, 'app-server', '--stdio'], {
      cwd: this.#cwd,
      env: this.#env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })

    const spawned = new Promise((resolve, reject) => {
      this.#child.once('spawn', resolve)
      this.#child.once('error', reject)
    })

    this.#child.on('exit', (code, signal) => {
      const error = new Error(`Codex app-server stopped (${code ?? signal ?? 'unknown'})`)
      for (const pending of this.#pending.values()) pending.reject(error)
      this.#pending.clear()
      this.emit('exit', error)
    })
    this.#child.on('error', error => {
      for (const pending of this.#pending.values()) pending.reject(error)
      this.#pending.clear()
      this.emit('exit', error)
    })
    this.#child.stderr.on('data', chunk => process.stderr.write(`[codex] ${chunk}`))

    const lines = createInterface({ input: this.#child.stdout })
    lines.on('line', line => this.#onLine(line))

    await spawned
    await this.request('initialize', {
      clientInfo: { name: 'codex_lens_g2', title: 'Codex Lens for Even G2', version: '0.2.1' },
      capabilities: { experimentalApi: true },
    })
    this.notify('initialized')
  }

  stop() {
    if (!this.#child) return
    this.#child.kill()
    this.#child = undefined
  }

  request(method, params = undefined, timeoutMs = 30_000) {
    if (!this.#child) throw new Error('Codex app-server is not running')
    const id = this.#nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new Error(`${method} timed out`))
      }, timeoutMs)
      this.#pending.set(id, {
        resolve: value => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: error => {
          clearTimeout(timer)
          reject(error)
        },
      })
      this.#write({ id, method, ...(params === undefined ? {} : { params }) })
    })
  }

  notify(method, params = undefined) {
    this.#write({ method, ...(params === undefined ? {} : { params }) })
  }

  waitFor(method, predicate = () => true, timeoutMs = 180_000) {
    return new Promise((resolve, reject) => {
      const listener = params => {
        if (!predicate(params)) return
        clearTimeout(timer)
        this.off(method, listener)
        resolve(params)
      }
      const timer = setTimeout(() => {
        this.off(method, listener)
        reject(new Error(`${method} was not received in time`))
      }, timeoutMs)
      this.on(method, listener)
    })
  }

  #write(message) {
    this.#child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  #onLine(line) {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return
    }

    if (message.id !== undefined && !message.method) {
      const pending = this.#pending.get(message.id)
      if (!pending) return
      this.#pending.delete(message.id)
      if (message.error) pending.reject(new Error(message.error.message || 'Codex request failed'))
      else pending.resolve(message.result)
      return
    }

    if (message.method && message.id !== undefined) {
      this.#write({
        id: message.id,
        error: { code: -32601, message: 'Codex Lens does not allow interactive approvals or tool input.' },
      })
      return
    }

    if (message.method) this.emit(message.method, message.params)
  }
}
