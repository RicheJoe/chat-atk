export const BFF_ORIGIN = 'http://127.0.0.1:8787'

export async function bffJson(path, options = {}) {
  const response = await fetch(`${BFF_ORIGIN}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers ?? {})
    }
  })
  if (response.status === 204) return null
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.message || `请求失败 ${response.status}`)
  return data
}

export async function readSse(response, onEvent) {
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const frames = buffer.split('\n\n')
    buffer = frames.pop() ?? ''
    for (const frame of frames) {
      const line = frame.split('\n').find((item) => item.startsWith('data: '))
      if (!line) continue
      onEvent(JSON.parse(line.slice(6)))
    }
  }
}
