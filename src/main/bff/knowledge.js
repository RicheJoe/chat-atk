import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'path'
import { Ollama } from 'ollama'

const EMBED_MODEL = 'bge-m3'
const TOP_K = 3
const SCORE_MIN = 0.7
const host =
  import.meta.env?.VITE_OLLAMA_HOST || process.env.VITE_OLLAMA_HOST || 'http://127.0.0.1:11434'
const client = new Ollama({ host })

const knowledgeDir = join(process.cwd(), 'knowledge/trademark')
const indexPath = join(process.cwd(), 'knowledge/trademark-index.json')

// 解析 front matter
function parseFrontMatter(raw) {
  if (!raw.startsWith('---\n')) return { meta: {}, body: raw }
  const end = raw.indexOf('\n---', 4)
  if (end === -1) return { meta: {}, body: raw }
  const meta = {}
  for (const line of raw.slice(4, end).split('\n')) {
    const sep = line.indexOf(':')
    if (sep === -1) continue
    const key = line.slice(0, sep).trim()
    const value = line.slice(sep + 1).trim()
    meta[key] = value
  }
  return { meta, body: raw.slice(end + 4).replace(/^\n/, '') }
}
// 分块 解析 markdown 文件
export function chunkKnowledge(filename, raw) {
  const { meta, body } = parseFrontMatter(raw)
  if (meta.index === false) return []
  const parts = body.split(/^## /m).slice(1)
  return parts
    .map((part) => {
      const nl = part.indexOf('\n')
      const heading = (nl === -1 ? part : part.slice(0, nl)).trim()
      const text = (nl === -1 ? '' : part.slice(nl + 1)).trim()
      if (!heading || !text) return null
      return {
        id: `${meta.id || filename}#${heading}`,
        title: `${meta.title || filename} / ${heading}`,
        updated: meta.updated || '',
        source: meta.source || '',
        text
      }
    })
    .filter(Boolean)
}

async function embed(text) {
  const result = await client.embed({
    model: EMBED_MODEL,
    input: text
  })
  const vector = result.embeddings?.[0]
  if (!vector) throw new Error('Failed to embed text')
  return vector
}

function cosine(a, b) {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

async function readChunks() {
  const files = (await readdir(knowledgeDir)).filter((name) => name.endsWith('.md'))
  const chunks = []
  for (const name of files.sort()) {
    const raw = await readFile(join(knowledgeDir, name), 'utf8')
    chunks.push(...chunkKnowledge(name, raw))
  }
  return chunks
}

export async function buildIndex() {
  const chunks = await readChunks()
  const items = []
  for (const chunk of chunks) {
    const vector = await embed(`${chunk.title}\n${chunk.text}`)
    items.push({ ...chunk, vector })
  }
  await writeFile(indexPath, JSON.stringify({ model: EMBED_MODEL, items }))
  return items.length
}
let indexPromise = null
async function loadIndex() {
  if (!indexPromise) {
    indexPromise = (async () => {
      try {
        const indexStat = await stat(indexPath)
        const files = (await readdir(knowledgeDir)).filter((name) => name.endsWith('.md'))
        const newest = Math.max(
          ...(await Promise.all(
            files.map(async (name) => (await stat(join(knowledgeDir, name))).mtimeMs)
          ))
        )
        if (indexStat.mtimeMs >= newest) {
          return JSON.parse(await readFile(indexPath, 'utf8')).items
        }
      } catch {
        // 索引不存在就重建
      }
      await buildIndex()
      return JSON.parse(await readFile(indexPath, 'utf8')).items
    })().catch((error) => {
      indexPromise = null
      throw error
    })
  }
  return indexPromise
}

export async function retrieve(query) {
  const items = await loadIndex()
  const queryVector = await embed(query)
  const ranked = items
    .map((item) => ({ ...item, score: cosine(queryVector, item.vector) }))
    .sort((a, b) => b.score - a.score)
  console.log(
    '检索',
    ranked.slice(0, TOP_K).map((item) => `${item.score.toFixed(3)} ${item.title}`)
  )
  if (!ranked.length || ranked[0].score < SCORE_MIN) return []
  return ranked.slice(0, TOP_K).map(({ vector, ...hit }) => hit)
}
const RULES = [
  '以下是本次检索到的资料。只根据这些资料回答，不要用资料以外的流程、费用或材料。',
  '费用和期限必须带上资料里的更新日期。',
  '资料之间的期限不一致时，分别说明出处和施行日期，不要合成一句「现在就是这样」。',
  '没有资料，或资料写明未收录金额、手续时，回答未收录。',
  '不要判断某个商标能否注册、是否近似或是否侵权。'
].join('\n')

export function retrievalMessage(hits) {
  if (!hits.length) {
    return {
      role: 'system',
      content: '本次没有检索到可用资料。不要凭记忆回答费用、期限、材料和转让手续，直接说明未收录。'
    }
  }
  const blocks = hits.map(
    (hit) =>
      `资料标题：${hit.title}\n更新日期：${hit.updated}\n来源：${hit.source}\n正文：\n${hit.text}`
  )
  return { role: 'system', content: `${RULES}\n\n${blocks.join('\n\n')}` }
}
