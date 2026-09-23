import { Router } from 'express'
import { streamChat } from '../chat.js'
import { prepareContext } from '../context.js'
import {
  DEFAULT_TITLE,
  appendMessage,
  createConversation,
  deleteConversation,
  getConversation,
  listConversations,
  patchSummary
} from '../../conversations.js'
import { retrievalMessage, retrieve } from '../knowledge.js'

export const conversationsRouter = Router()

function isAbortError(error) {
  return error?.name === 'AbortError' || error?.code === 'ABORT_ERR'
}

function promptMessages(messages) {
  return messages
    .filter((msg) => !msg.error && String(msg.content ?? '').trim())
    .map(({ role, content }) => ({ role, content }))
}

function sourceRefs(hits) {
  return hits.map((hit) => ({
    title: hit.title,
    updated: hit.updated,
    source: hit.source
  }))
}

function assistantMessage(content, sources, extra = {}) {
  const message = { role: 'assistant', content, ...extra }
  if (sources.length) message.sources = sources
  return message
}

function beginSse(res) {
  const ac = new AbortController()
  res.on('close', () => {
    if (!res.writableEnded) ac.abort()
  })
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  })
  const write = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`)
  return { signal: ac.signal, write }
}

conversationsRouter.get('/', async (_req, res) => {
  res.json(await listConversations())
})

conversationsRouter.post('/', async (_req, res) => {
  res.status(201).json(await createConversation())
})

conversationsRouter.get('/:id', async (req, res) => {
  const conversation = await getConversation(req.params.id)
  if (!conversation) return res.status(404).json({ message: '会话不存在' })
  res.json(conversation)
})

conversationsRouter.delete('/:id', async (req, res) => {
  await deleteConversation(req.params.id)
  res.status(204).end()
})

conversationsRouter.post('/:id/messages', async (req, res) => {
  const text = String(req.body?.content ?? '').trim()
  const model = req.body?.model
  const provider = req.body?.provider || 'ollama'
  if (!text || !model) {
    return res.status(400).json({ message: 'content 和 model 必填' })
  }

  const existing = await getConversation(req.params.id)
  if (!existing) return res.status(404).json({ message: '会话不存在' })

  const title = existing.title === DEFAULT_TITLE ? text.slice(0, 18) : existing.title
  await appendMessage(existing.id, { role: 'user', content: text }, { title })
  const stored = await getConversation(existing.id)
  const { signal, write } = beginSse(res)
  let assistant = ''
  let sources = []

  try {
    const prepared = await prepareContext({
      provider,
      model,
      messages: promptMessages(stored.messages),
      summary: stored.summary,
      summarizedCount: stored.summarizedCount,
      signal
    })
    if (prepared.changed) {
      await patchSummary(existing.id, prepared.summary, prepared.summarizedCount)
      write({
        type: 'summary',
        summary: prepared.summary,
        summarizedCount: prepared.summarizedCount
      })
    }

    // 检索知识库
    let hits = []
    try {
      hits = await retrieve(text)
    } catch (error) {
      console.error('检索失败', error)
    }
    const messages = prepared.messages.slice()
    messages.splice(messages.length - 1, 0, retrievalMessage(hits))
    sources = sourceRefs(hits)
    write({ type: 'sources', sources })
    await streamChat({
      provider,
      model,
      messages,
      signal,
      onEvent: (event) => {
        if (event.type === 'chunk') {
          assistant += event.content
          write(event)
        }
      }
    })
    if (assistant.trim()) {
      await appendMessage(existing.id, assistantMessage(assistant, sources))
    }
    if (!signal.aborted) write({ type: 'done', title })
  } catch (error) {
    if (signal.aborted || isAbortError(error)) {
      if (assistant.trim()) {
        await appendMessage(existing.id, assistantMessage(assistant, sources))
      }
      return
    }
    if (!assistant.trim()) {
      await appendMessage(existing.id, assistantMessage(String(error), [], { error: true }))
    } else {
      await appendMessage(existing.id, assistantMessage(assistant, sources))
    }
    write({ type: 'error', message: String(error) })
  } finally {
    res.end()
  }
})
