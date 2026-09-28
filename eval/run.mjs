import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chunkKnowledge, retrievalMessage, retrieve } from '../src/main/bff/knowledge.js'
import { SYSTEM_PROMPT } from '../src/main/bff/prompt.js'
import { measureParts } from '../src/main/bff/promptUsage.js'
import { toolGuide, trademarkTools } from '../src/main/bff/tools.js'

const root = join(import.meta.dirname, '..')
const knowledgeDir = join(root, 'knowledge/trademark')
const toolsByName = Object.fromEntries(trademarkTools.map((item) => [item.name, item]))

function same(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected)
}

function classNos(result) {
  return (result.candidates ?? []).map((item) => item.classNo)
}

async function titlesInKnowledge() {
  const files = (await readdir(knowledgeDir)).filter((name) => name.endsWith('.md'))
  const titles = new Set()
  for (const name of files) {
    const raw = await readFile(join(knowledgeDir, name), 'utf8')
    for (const chunk of chunkKnowledge(name, raw)) titles.add(chunk.title)
  }
  return titles
}

async function runToolCheck(check) {
  const tool = toolsByName[check.name]
  if (!tool) return { ok: false, detail: `没有工具 ${check.name}` }
  const raw = await tool.invoke(check.input)
  const result = JSON.parse(typeof raw === 'string' ? raw : JSON.stringify(raw))
  const actual = {}
  for (const key of Object.keys(check.expect)) {
    actual[key] = key === 'classNos' ? classNos(result) : result[key]
  }
  return { ok: same(actual, check.expect), actual, result }
}

function classify({ item, hits, answer, toolOk, retrievalAttempted }) {
  const tags = []
  if (retrievalAttempted && item.titles?.length) {
    if (!hits) tags.push('retrieval_unavailable')
    else if (!item.titles.every((title) => hits.some((hit) => hit.title === title))) {
      tags.push('retrieval_miss')
    } else if (answer && !item.titles.every((title) => answer.includes(title.split(' / ')[1]))) {
      tags.push('retrieval_unused')
    }
  }
  if (item.toolCheck && !toolOk) tags.push('tool_args')
  if (answer && item.refuse) {
    const refused = /不能|不判断|不予|无法判断|不构成法律/.test(answer)
    const decided = (item.mustNot ?? []).some((word) => answer.includes(word))
    if (!refused || decided) tags.push('out_of_scope')
  }
  if (answer) {
    for (const word of item.mustMention ?? []) {
      if (!answer.includes(word)) tags.push('retrieval_unused')
    }
  }
  return [...new Set(tags)]
}

async function main() {
  const cases = JSON.parse(await readFile(join(import.meta.dirname, 'cases.json'), 'utf8'))
  const knownTitles = await titlesInKnowledge()
  const skipRetrieval = process.argv.includes('--skip-retrieval')
  const rows = []

  for (const item of cases) {
    const missingTitle = (item.titles ?? []).filter((title) => !knownTitles.has(title))
    let toolOk = true
    let toolActual = null
    if (item.toolCheck) {
      const checked = await runToolCheck(item.toolCheck)
      toolOk = checked.ok
      toolActual = checked.actual
    }
    let hits = null
    let retrievalError = ''
    const retrievalAttempted = !skipRetrieval && item.titles?.length > 0
    if (retrievalAttempted) {
      try {
        hits = await retrieve(item.question)
      } catch (error) {
        retrievalError = String(error?.message || error)
      }
    }
    const tags = classify({ item, hits, answer: '', toolOk, retrievalAttempted })
    if (missingTitle.length) tags.push('retrieval_miss')
    rows.push({
      id: item.id,
      path: item.path,
      question: item.question,
      missingTitle,
      toolOk,
      toolActual,
      hits: hits?.map((hit) => ({ title: hit.title, score: Number(hit.score.toFixed(3)) })) ?? null,
      retrievalError,
      tags
    })
  }

  const fee = JSON.parse(
    await toolsByName.estimate_fee.invoke({ classCount: 1, extraItemCount: 0 })
  )
  const sampleHit = {
    title: '规费清单 / 受理商标注册费',
    updated: '2026-09-28',
    source: 'https://sbj.cnipa.gov.cn/sfbz/index.html',
    text: '纸质申请每类 300 元。接受电子发文的网上申请每类 270 元。',
    score: 1
  }
  const usage = measureParts({
    system: `${SYSTEM_PROMPT}\n${toolGuide.content}`,
    knowledge: retrievalMessage([sampleHit]).content,
    history: '一类大概多少钱',
    tools: JSON.stringify(fee)
  })

  const summary = {
    at: new Date().toISOString(),
    model: '未跑模型。retrieval_unused 和 out_of_scope 需要对照回答原文',
    counts: rows.reduce((acc, row) => {
      const tags = row.tags.length ? row.tags : ['ok']
      for (const tag of tags) acc[tag] = (acc[tag] || 0) + 1
      return acc
    }, {}),
    usage,
    rows
  }
  await writeFile(join(import.meta.dirname, 'last-run.json'), JSON.stringify(summary, null, 2))
  console.log(JSON.stringify({ counts: summary.counts, usage: summary.usage }, null, 2))
  for (const row of rows) {
    if (row.missingTitle.length || row.tags.length) {
      console.log(row.id, row.tags.join(',') || 'title', row.missingTitle, row.retrievalError)
    }
  }
}

await main()
