import * as ollama from './ollama.js'

const providers = { ollama }

export function getProvider(name) {
  const provider = providers[name]
  if (!provider) {
    throw new Error(`未知 provider: ${name}`)
  }
  return provider
}
