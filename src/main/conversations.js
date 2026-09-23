import { app } from 'electron'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { join } from 'path'

export const DEFAULT_TITLE = '新对话'
export const SYSTEM_PROMPT = '你是知识产权流程客服，用中文回答。'

let conversations = null
let writing = Promise.resolve()

function filePath() {
  return join(app.getPath('userData'), 'conversations.json')
}

function rememberedMessages(messages) {
  return (messages ?? []).filter((msg) => {
    if (!msg) return false
    if (msg.role === 'system') return true
    if (msg.error) return true
    return String(msg.content ?? '').trim().length > 0
  })
}

async function ensure() {
  if (conversations) return
  try {
    const parsed = JSON.parse(await readFile(filePath(), 'utf8'))
    conversations = Array.isArray(parsed) ? parsed : []
  } catch {
    conversations = []
  }
}

function queueWrite() {
  const snapshot = JSON.stringify(conversations, null, 2)
  writing = writing.then(async () => {
    await mkdir(app.getPath('userData'), { recursive: true })
    await writeFile(filePath(), snapshot)
  })
  return writing
}

export async function createConversation() {
  await ensure()
  const now = Date.now()
  const conversation = {
    id: `conv_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    title: DEFAULT_TITLE,
    updatedAt: now,
    summary: '',
    summarizedCount: 0,
    messages: [{ role: 'system', content: SYSTEM_PROMPT }]
  }
  conversations.push(conversation)
  await queueWrite()
  return conversation
}

export async function appendMessage(id, message, patch = {}) {
  await ensure()
  const item = conversations.find((entry) => entry.id === id)
  if (!item) return null
  if (message) item.messages.push(message)
  if (patch.title) item.title = patch.title
  item.updatedAt = Date.now()
  await queueWrite()
  return item
}

export async function listConversations() {
  await ensure()
  return conversations
    .map(({ id, title, updatedAt }) => ({ id, title, updatedAt }))
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function getConversation(id) {
  await ensure()
  const found = conversations.find((item) => item.id === id)
  if (!found) return null
  return { ...found, messages: rememberedMessages(found.messages) }
}

export async function saveConversation(conversation) {
  await ensure()
  const index = conversations.findIndex((item) => item.id === conversation.id)
  const next = {
    id: conversation.id,
    title: conversation.title || '新对话',
    updatedAt: conversation.updatedAt || Date.now(),
    summary: conversation.summary || '',
    summarizedCount: conversation.summarizedCount || 0,
    messages: rememberedMessages(conversation.messages)
  }
  if (index === -1) {
    conversations.push(next)
  } else {
    const prev = conversations[index]
    if ((prev.summarizedCount || 0) > next.summarizedCount) {
      next.summary = prev.summary
      next.summarizedCount = prev.summarizedCount
    }
    conversations[index] = next
  }
  await queueWrite()
  return next
}

export async function patchSummary(id, summary, summarizedCount) {
  await ensure()
  const item = conversations.find((entry) => entry.id === id)
  if (!item) return null
  item.summary = summary || ''
  item.summarizedCount = summarizedCount || 0
  await queueWrite()
  return { summary: item.summary, summarizedCount: item.summarizedCount }
}

export async function deleteConversation(id) {
  await ensure()
  conversations = conversations.filter((item) => item.id !== id)
  await queueWrite()
  return { success: true }
}
