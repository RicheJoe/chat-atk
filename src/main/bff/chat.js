import { ToolMessage } from '@langchain/core/messages'
import { ChatPromptTemplate, MessagesPlaceholder } from '@langchain/core/prompts'
import { RunnableLambda, RunnableSequence } from '@langchain/core/runnables'
import { concat } from '@langchain/core/utils/stream'
import { documentsToHits, retrievalMessage, trademarkRetriever } from './knowledge.js'
import { messageText, modelFor } from './providers/ollama.js'
import { TOOL_LABELS, toolGuide, trademarkTools } from './tools.js'

const toolsByName = Object.fromEntries(trademarkTools.map((item) => [item.name, item]))

const answerPrompt = ChatPromptTemplate.fromMessages([
  new MessagesPlaceholder({ variableName: 'prefix', optional: true }),
  new MessagesPlaceholder('retrieval'),
  new MessagesPlaceholder('guide'),
  new MessagesPlaceholder('question')
])

function prepareChain(onSources) {
  return RunnableSequence.from([
    RunnableLambda.from(async ({ messages, query }, config) => {
      let hits = []
      try {
        hits = documentsToHits(await trademarkRetriever.invoke(query, config))
      } catch (error) {
        if (config?.signal?.aborted || error?.name === 'AbortError') throw error
        console.error('检索失败', error)
      }
      onSources?.(hits)
      return {
        prefix: messages.slice(0, -1),
        retrieval: [retrievalMessage(hits)],
        guide: [toolGuide],
        question: messages.slice(-1)
      }
    }),
    answerPrompt
  ])
}

function toolArgs(call) {
  if (call?.args && typeof call.args === 'object') return call.args
  if (typeof call?.args === 'string') {
    try {
      return JSON.parse(call.args)
    } catch {
      return {}
    }
  }
  return {}
}

async function runTools(calls, signal, onTool) {
  const messages = []
  for (const [index, call] of calls.entries()) {
    if (signal?.aborted) return messages
    const name = call.name
    const label = TOOL_LABELS[name] || name
    onTool?.({ name, label, status: 'running' })
    const selected = toolsByName[name]
    let content
    try {
      content = selected
        ? await selected.invoke(toolArgs(call))
        : JSON.stringify({ error: `未知工具 ${name}` })
    } catch (error) {
      content = JSON.stringify({ error: String(error?.message || error) })
    }
    if (typeof content !== 'string') content = JSON.stringify(content)
    onTool?.({ name, label, status: 'done' })
    messages.push(
      new ToolMessage({
        content,
        tool_call_id: call.id || `${name}_${index}`,
        name
      })
    )
  }
  return messages
}

async function emitStream(stream, signal, onChunk) {
  let gathered
  try {
    for await (const chunk of stream) {
      if (signal?.aborted) return gathered
      gathered = gathered ? concat(gathered, chunk) : chunk
      if (chunk.tool_call_chunks?.length || chunk.tool_calls?.length) continue
      const content = messageText(chunk)
      if (content) onChunk?.(content)
    }
  } catch (error) {
    if (signal?.aborted || error?.name === 'AbortError') return gathered
    throw error
  }
  return gathered
}

export async function streamChat({ model, messages, query, signal, onSources, onChunk, onTool }) {
  if (!model || !Array.isArray(messages) || !query) {
    throw new Error('model、messages 和 query 必填')
  }

  const prepared = await prepareChain(onSources).invoke({ messages, query }, { signal })
  const history = prepared.messages
  const llm = modelFor(model).bindTools(trademarkTools)
  const first = await emitStream(await llm.stream(history, { signal }), signal, onChunk)
  const calls = first?.tool_calls ?? []
  if (!calls.length || signal?.aborted) return

  const toolMessages = await runTools(calls, signal, onTool)
  if (!toolMessages.length || signal?.aborted) return
  await emitStream(
    await modelFor(model).stream([...history, first, ...toolMessages], { signal }),
    signal,
    onChunk
  )
}
