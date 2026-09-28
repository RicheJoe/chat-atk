export const PASSAGE_LIMIT = 800

export function charCount(text) {
  return Array.from(String(text ?? '')).length
}

export function clipText(text, limit = PASSAGE_LIMIT) {
  const value = String(text ?? '').trim()
  const chars = Array.from(value)
  if (chars.length <= limit) return { text: value, clipped: false }
  return { text: `${chars.slice(0, limit).join('')}…`, clipped: true }
}

export function measureParts({ system = '', knowledge = '', history = '', tools = '' }) {
  const parts = {
    系统提示: charCount(system),
    资料: charCount(knowledge),
    历史: charCount(history),
    工具结果: charCount(tools)
  }
  parts.合计 = parts.系统提示 + parts.资料 + parts.历史 + parts.工具结果
  return parts
}
