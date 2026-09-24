import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'path'
import { Document } from '@langchain/core/documents'
import { BaseRetriever } from '@langchain/core/retrievers'
import { OllamaEmbeddings } from '@langchain/ollama'
import { ChromaClient } from 'chromadb'

const COLLECTION = 'trademark'
const chroma = new ChromaClient({
  ssl: false,
  host: '127.0.0.1',
  port: 8000
})

function isCosine(collection) {
  return collection.configuration?.hnsw?.space === 'cosine'
}

async function openCollection() {
  try {
    const current = await chroma.getCollection({
      name: COLLECTION,
      embeddingFunction: null
    })
    if (isCosine(current)) return current
    await chroma.deleteCollection({ name: COLLECTION })
  } catch {
    // 集合还不存在
  }
  return chroma.createCollection({
    name: COLLECTION,
    embeddingFunction: null,
    configuration: { hnsw: { space: 'cosine' } }
  })
}

const EMBED_MODEL = 'bge-m3'
const TOP_K = 3
const SCORE_MIN = 0.7
const host =
  import.meta.env?.VITE_OLLAMA_HOST || process.env.VITE_OLLAMA_HOST || 'http://127.0.0.1:11434'
const embeddings = new OllamaEmbeddings({ model: EMBED_MODEL, baseUrl: host })

const knowledgeDir = join(process.cwd(), 'knowledge/trademark')
const stampPath = join(process.cwd(), 'knowledge/.chroma-stamp')

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
  if (meta.index === 'false') return []
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
  const vector = await embeddings.embedQuery(text)
  if (!vector?.length) throw new Error('Failed to embed text')
  return vector
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
  const vectors = chunks.length
    ? await embeddings.embedDocuments(chunks.map((chunk) => `${chunk.title}\n${chunk.text}`))
    : []
  const collection = await openCollection()
  if (chunks.length) {
    await collection.upsert({
      ids: chunks.map((chunk) => chunk.id),
      embeddings: vectors,
      documents: chunks.map((chunk) => chunk.text),
      metadatas: chunks.map((chunk) => ({
        title: chunk.title,
        updated: chunk.updated,
        source: chunk.source
      }))
    })
  }
  const existing = await collection.get({ include: [] })
  const keep = new Set(chunks.map((chunk) => chunk.id))
  const stale = existing.ids.filter((id) => !keep.has(id))
  if (stale.length) await collection.delete({ ids: stale })
  return chunks.length
}

let indexPromise = null

async function loadIndex() {
  if (!indexPromise) {
    indexPromise = syncIndex().catch((error) => {
      indexPromise = null
      throw error
    })
  }
  return indexPromise
}

async function syncIndex() {
  const files = (await readdir(knowledgeDir)).filter((name) => name.endsWith('.md'))
  const newest = Math.max(
    ...(await Promise.all(
      files.map(async (name) => (await stat(join(knowledgeDir, name))).mtimeMs)
    ))
  )
  let stampTime = 0
  let stampModel = ''
  try {
    stampTime = (await stat(stampPath)).mtimeMs
    stampModel = (await readFile(stampPath, 'utf8')).trim()
  } catch {
    // 还没有标记文件，需要建索引
  }
  const collection = await openCollection()
  const ready = stampTime >= newest && stampModel === EMBED_MODEL && (await collection.count()) > 0
  if (ready) return
  await buildIndex()
  await writeFile(stampPath, EMBED_MODEL)
}

class TrademarkRetriever extends BaseRetriever {
  lc_namespace = ['my-ai-chat', 'retrievers']

  async _getRelevantDocuments(query) {
    await loadIndex()
    const collection = await openCollection()
    const queryVector = await embed(query)
    const result = await collection.query({
      queryEmbeddings: [queryVector],
      nResults: TOP_K
    })
    const ranked = (result.rows()[0] ?? []).map((row) => ({
      title: row.metadata?.title ?? '',
      updated: row.metadata?.updated ?? '',
      source: row.metadata?.source ?? '',
      text: row.document ?? '',
      score: 1 - (row.distance ?? 1)
    }))
    console.log(
      '检索',
      ranked.map((hit) => `${hit.score.toFixed(3)} ${hit.title}`)
    )
    return ranked
      .filter((hit) => hit.score >= SCORE_MIN)
      .map(
        (hit) =>
          new Document({
            pageContent: hit.text,
            metadata: {
              title: hit.title,
              updated: hit.updated,
              source: hit.source,
              score: hit.score
            }
          })
      )
  }
}

export const trademarkRetriever = new TrademarkRetriever()

export function documentsToHits(docs) {
  return (docs ?? []).map((doc) => ({
    title: doc.metadata?.title ?? '',
    updated: doc.metadata?.updated ?? '',
    source: doc.metadata?.source ?? '',
    text: doc.pageContent ?? '',
    score: doc.metadata?.score ?? 0
  }))
}

export async function retrieve(query) {
  return documentsToHits(await trademarkRetriever.invoke(query))
}
const RULES = [
  '以下是本次检索到的资料。流程和期限只根据这些资料回答。',
  '费用金额和材料清单以工具返回为准。工具写明未收录时，回答未收录，不要心算。',
  '费用和期限必须带上资料或工具里的更新日期。',
  '资料之间的期限不一致时，分别说明出处和施行日期，不要合成一句「现在就是这样」。',
  '没有资料，或资料写明未收录金额、手续时，回答未收录。',
  '不要判断某个商标能否注册、是否近似或是否侵权。'
].join('\n')

export function retrievalMessage(hits) {
  if (!hits.length) {
    return {
      role: 'system',
      content:
        '本次没有检索到可用资料。不要凭记忆回答费用、期限、材料和转让手续。若调用了工具，只根据工具返回回答；工具未收录的金额直接说明未收录。'
    }
  }
  const blocks = hits.map(
    (hit) =>
      `资料标题：${hit.title}\n更新日期：${hit.updated}\n来源：${hit.source}\n正文：\n${hit.text}`
  )
  return { role: 'system', content: `${RULES}\n\n${blocks.join('\n\n')}` }
}
