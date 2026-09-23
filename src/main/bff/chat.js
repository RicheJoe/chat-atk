import { getProvider } from './providers/index.js'

export async function streamChat({ provider = 'ollama', model, messages, signal, onEvent }) {
  if (!model || !Array.isArray(messages)) {
    throw new Error('model 和 messages 必填')
  }

  for await (const content of getProvider(provider).chat({ model, messages, signal })) {
    if (signal?.aborted) return
    onEvent({ type: 'chunk', content })
  }

  if (!signal?.aborted) onEvent({ type: 'done' })
}
