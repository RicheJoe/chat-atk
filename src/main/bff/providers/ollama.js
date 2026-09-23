import { Ollama } from 'ollama'

const host = import.meta.env.VITE_OLLAMA_HOST || 'http://127.0.0.1:11434'
const client = new Ollama({ host })

export async function listModels() {
  const response = await fetch(`${host}/api/tags`)
  if (!response.ok) {
    throw new Error(`Ollama /api/tags 失败: ${response.status}`)
  }
  const data = await response.json()
  console.log(data, 'models data')
  return (data.models ?? []).map((item) => ({
    name: item.name || item.model,
    size: item.size ?? 0,
    parameterSize: item.details?.parameter_size ?? '',
    modifiedAt: item.modified_at ?? ''
  }))
}

export async function* chat({ model, messages, signal }) {
  const stream = await client.chat({ model, messages, stream: true })
  signal?.addEventListener('abort', () => stream.abort(), { once: true })

  for await (const chunk of stream) {
    const content = chunk.message?.content
    if (content) yield content
  }
}

export async function complete({ model, messages, signal }) {
  if (signal?.aborted) {
    const error = new Error('Aborted')
    error.name = 'AbortError'
    throw error
  }

  const pending = client.chat({ model, messages, stream: false })
  const result = await new Promise((resolve, reject) => {
    const onAbort = () => {
      const error = new Error('Aborted')
      error.name = 'AbortError'
      reject(error)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    pending.then(resolve, reject).finally(() => signal?.removeEventListener('abort', onAbort))
  })
  return result.message?.content?.trim() ?? ''
}
