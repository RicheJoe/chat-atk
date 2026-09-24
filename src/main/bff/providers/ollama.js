import { ChatOllama } from '@langchain/ollama'

const host = import.meta.env?.VITE_OLLAMA_HOST || 'http://127.0.0.1:11434'
const chatModel = new ChatOllama({ baseUrl: host })

export function modelFor(model) {
  return new ChatOllama({ baseUrl: host, model })
}

export function messageText(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((part) => (typeof part === 'string' ? part : part?.text || '')).join('')
}

export async function listModels() {
  const { models } = await chatModel.client.list()
  console.log(
    models.map((item) => item.name),
    '本地ollama-models'
  )
  return (models ?? []).map((item) => ({
    name: item.name || item.model,
    size: item.size ?? 0,
    parameterSize: item.details?.parameter_size ?? '',
    modifiedAt:
      item.modified_at instanceof Date ? item.modified_at.toISOString() : (item.modified_at ?? '')
  }))
}
