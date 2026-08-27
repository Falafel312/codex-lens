import { randomBytes } from 'node:crypto'

function id(bytes = 12) {
  return randomBytes(bytes).toString('base64url')
}

function textFromContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(part => {
      if (typeof part === 'string') return part
      if (['text', 'input_text', 'output_text'].includes(part?.type)) return part.text || ''
      if (part?.type === 'audio' || part?.type === 'localAudio') return 'Voice prompt'
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function normalizeItem(item) {
  if (item?.type === 'userMessage') {
    return { id: item.id || id(), role: 'user', text: textFromContent(item.content) || 'Voice prompt' }
  }
  if (item?.type === 'agentMessage') {
    return { id: item.id || id(), role: 'assistant', text: String(item.text || '') }
  }
  return null
}

function normalizeThread(thread) {
  const title = String(thread.title || thread.preview || 'Untitled Codex thread').replace(/\s+/g, ' ').trim()
  return {
    id: thread.id,
    title,
    preview: String(thread.preview || title),
    updatedAt: thread.recencyAt || thread.updatedAt || thread.createdAt,
  }
}

export class CodexService {
  constructor(appServer, cwd) {
    this.appServer = appServer
    this.cwd = cwd
  }

  async account() {
    const result = await this.appServer.request('account/read', { refreshToken: false })
    return result.account || null
  }

  async beginLogin() {
    return this.appServer.request('account/login/start', { type: 'chatgptDeviceCode' })
  }

  async logout() {
    await this.appServer.request('account/logout')
  }

  async threadMessages(threadId) {
    try {
      const result = await this.appServer.request('thread/items/list', {
        threadId,
        limit: 100,
        sortDirection: 'asc',
      })
      return (result.data || []).map(entry => normalizeItem(entry.item)).filter(item => item?.text)
    } catch {
      const result = await this.appServer.request('thread/read', { threadId, includeTurns: true })
      return (result.thread?.turns || [])
        .flatMap(turn => turn.items || [])
        .map(normalizeItem)
        .filter(item => item?.text)
    }
  }

  async sendTurn(threadId, input) {
    try {
      await this.appServer.request('thread/resume', {
        threadId,
        excludeTurns: true,
        approvalPolicy: 'never',
        sandbox: 'read-only',
        personality: 'friendly',
      })
    } catch (error) {
      if (!String(error.message).includes('already loaded')) throw error
    }

    const started = await this.appServer.request('turn/start', {
      threadId,
      input: [input],
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'readOnly' },
      personality: 'friendly',
    })
    const turnId = started.turn?.id
    await this.appServer.waitFor(
      'turn/completed',
      params => params?.threadId === threadId && params?.turn?.id === turnId,
      5 * 60 * 1000,
    )
    const messages = await this.threadMessages(threadId)
    const message = [...messages].reverse().find(item => item.role === 'assistant')
    if (!message) throw new Error('Codex completed without a text response')
    return message
  }

  async handle({ method = 'GET', path, body = {} }) {
    if (method === 'GET' && path === '/v1/account') return { account: await this.account() }

    if (method === 'GET' && path === '/v1/threads') {
      const result = await this.appServer.request('thread/list', {
        limit: 24,
        sortKey: 'recency_at',
        sortDirection: 'desc',
      })
      return { threads: (result.data || []).map(normalizeThread) }
    }

    if (method === 'POST' && path === '/v1/threads') {
      const result = await this.appServer.request('thread/start', {
        cwd: this.cwd,
        approvalPolicy: 'never',
        sandbox: 'read-only',
        personality: 'friendly',
      })
      return { thread: normalizeThread(result.thread) }
    }

    const threadMatch = path.match(/^\/v1\/threads\/([^/]+)$/)
    if (method === 'GET' && threadMatch) {
      return { messages: await this.threadMessages(decodeURIComponent(threadMatch[1])) }
    }

    const turnMatch = path.match(/^\/v1\/threads\/([^/]+)\/turns$/)
    if (method === 'POST' && turnMatch) {
      const threadId = decodeURIComponent(turnMatch[1])
      if (body.type === 'text' && typeof body.text === 'string' && body.text.trim()) {
        return { message: await this.sendTurn(threadId, { type: 'text', text: body.text.trim() }) }
      }
      if (body.type === 'audio' && typeof body.audioBase64 === 'string' && body.audioBase64.length) {
        return {
          message: await this.sendTurn(threadId, {
            type: 'audio',
            url: `data:audio/wav;base64,${body.audioBase64}`,
          }),
        }
      }
      throw new Error('A text or audio prompt is required')
    }

    throw new Error('Unsupported Codex Lens request')
  }
}
