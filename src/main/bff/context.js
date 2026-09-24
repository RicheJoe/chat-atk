import { ChatPromptTemplate } from '@langchain/core/prompts'
import { RunnableLambda, RunnableSequence } from '@langchain/core/runnables'
import { getProvider } from './providers/index.js'
import { messageText, modelFor } from './providers/ollama.js'

const summaryPrompt = ChatPromptTemplate.fromMessages([['human', '{prompt}']])

const TOKEN_BUDGET = 6000
const SUMMARY_RESERVE = 400
const DEFAULT_SYSTEM = '你是知识产权流程客服，用中文回答。'

function estimateTokens(text) {
  return Array.from(text ?? '').length
}

function usableMessages(messages) {
  return (messages ?? []).filter((msg) => {
    if (!msg) return false
    if (msg.role !== 'system' && msg.role !== 'user' && msg.role !== 'assistant') return false
    if (msg.error) return false
    return String(msg.content ?? '').trim().length > 0
  })
}

function slim(msg) {
  return { role: msg.role, content: msg.content }
}

export function buildContextMessages({ messages, summary = '' }) {
  const usable = usableMessages(messages)
  const system = usable.find((msg) => msg.role === 'system')
  const rest = usable.filter((msg) => msg.role !== 'system')
  const systemMsg = { role: 'system', content: system?.content?.trim() || DEFAULT_SYSTEM }
  const systemCost = estimateTokens(systemMsg.content)
  const restCost = rest.reduce((sum, msg) => sum + estimateTokens(msg.content) + 8, 0)

  if (systemCost + restCost <= TOKEN_BUDGET) {
    return { messages: [systemMsg, ...rest.map(slim)], dropped: [], droppedCount: 0 }
  }

  const kept = []
  let used = systemCost + SUMMARY_RESERVE
  for (let i = rest.length - 1; i >= 0; i--) {
    const cost = estimateTokens(rest[i].content) + 8
    if (kept.length > 0 && used + cost > TOKEN_BUDGET) break
    kept.unshift(rest[i])
    used += cost
  }

  const dropped = rest.slice(0, rest.length - kept.length)
  const clippedSummary = String(summary).slice(0, SUMMARY_RESERVE).trim()
  const prompt = [systemMsg]
  if (clippedSummary) {
    prompt.push({ role: 'system', content: `此前对话摘要：\n${clippedSummary}` })
  }
  prompt.push(...kept.map(slim))
  return { messages: prompt, dropped, droppedCount: dropped.length }
}

function summaryPromptText({ summary, dropped }) {
  const transcript = dropped
    .map((msg) => `${msg.role === 'user' ? '用户' : '助手'}：${msg.content}`)
    .join('\n')
  const clipped = transcript.length > 4000 ? transcript.slice(-4000) : transcript
  return [
    '请把对话压缩成可继续聊天的中文摘要，保留身份、偏好、决定和未完成事项。控制在 300 字以内。',
    summary ? `已有摘要：\n${summary}` : '',
    `新增对话：\n${clipped}`
  ]
    .filter(Boolean)
    .join('\n\n')
}

function summaryChain(model) {
  return RunnableSequence.from([
    RunnableLambda.from((input) => ({ prompt: summaryPromptText(input) })),
    summaryPrompt,
    modelFor(model)
  ])
}

function abortError() {
  const error = new Error('Aborted')
  error.name = 'AbortError'
  return error
}

async function summarize({ provider, model, summary, dropped, signal }) {
  getProvider(provider)
  if (dropped.length === 0) return ''
  if (signal?.aborted) throw abortError()

  const result = await summaryChain(model).invoke({ summary, dropped }, { signal })
  if (signal?.aborted) throw abortError()
  return messageText(result).trim()
}

export async function prepareContext({
  provider = 'ollama',
  model,
  messages,
  summary = '',
  summarizedCount = 0,
  signal
}) {
  const covered = summarizedCount || 0
  const draft = buildContextMessages({ messages, summary })
  if (draft.droppedCount <= covered) {
    return { messages: draft.messages, summary, summarizedCount: covered, changed: false }
  }
  if (signal?.aborted) {
    const error = new Error('Aborted')
    error.name = 'AbortError'
    throw error
  }

  try {
    const nextSummary = await summarize({
      provider,
      model,
      summary,
      dropped: draft.dropped.slice(covered),
      signal
    })
    if (!nextSummary) {
      return { messages: draft.messages, summary, summarizedCount: covered, changed: false }
    }
    const rebuilt = buildContextMessages({ messages, summary: nextSummary })
    return {
      messages: rebuilt.messages,
      summary: nextSummary,
      summarizedCount: draft.droppedCount,
      changed: true
    }
  } catch (error) {
    if (signal?.aborted || error?.name === 'AbortError') throw error
    return { messages: draft.messages, summary, summarizedCount: covered, changed: false }
  }
}
