<template>
  <div class="chat">
    <header class="topbar">
      <div>
        <h1>{{ conversation.title }}</h1>
        <select v-model="model" :disabled="isStreaming || models.length === 0">
          <option v-if="models.length === 0" value="">{{ modelsError || '无本地模型' }}</option>
          <option v-for="item in models" :key="item.name" :value="item.name">
            {{ item.name }}
          </option>
        </select>
      </div>
      <span class="status" :class="{ busy: isStreaming }">
        {{ isStreaming ? '生成中' : '就绪' }}
      </span>
    </header>

    <div ref="scroller" class="messages">
      <div v-if="visibleMessages.length === 0" class="empty">
        <p>发一条消息，开始对话</p>
        <span>回复由本机 Ollama 生成</span>
      </div>
      <div v-for="(msg, i) in visibleMessages" :key="i" :class="['row', msg.role]">
        <div class="bubble">
          <p v-if="msg.role === 'user'" class="text">{{ msg.content }}</p>
          <template v-else>
            <div v-if="msg.queries?.length" class="queries">
              <p v-for="(item, queryIndex) in msg.queries" :key="`${item.name}-${queryIndex}`">
                {{ item.status === 'running' ? '正在查询' : '已查询' }}：{{ item.label }}
              </p>
            </div>
            <!-- markdown-it 已关闭原始 HTML，只渲染标题、列表、代码和链接 -->
            <!-- eslint-disable vue/no-v-html -->
            <div
              class="md"
              v-html="renderMarkdown(msg.content, isStreaming && i === visibleMessages.length - 1)"
            ></div>
            <!-- eslint-enable vue/no-v-html -->
          </template>
          <div v-if="msg.role === 'assistant' && msg.sources?.length" class="sources">
            <span class="sources-label">依据</span>
            <ul>
              <li v-for="item in msg.sources" :key="item.title">
                <span class="source-title">{{ item.title }}</span>
                <span class="source-date">{{ item.updated }}</span>
              </li>
            </ul>
          </div>
        </div>
      </div>
    </div>

    <form class="composer" @submit.prevent="sendMessage">
      <input v-model="input" placeholder="输入消息，Enter 发送" />
      <button type="submit" :disabled="!canSend">发送</button>
      <button type="button" class="stop" :disabled="!isStreaming" @click="stopStreaming">
        停止
      </button>
    </form>
  </div>
</template>

<script setup>
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'
import MarkdownIt from 'markdown-it'
import { DEFAULT_TITLE } from '../conversation'
import { BFF_ORIGIN, readSse } from '../bffClient'

const markdown = new MarkdownIt({ html: false, linkify: true, breaks: true })
const renderLinkOpen =
  markdown.renderer.rules.link_open ||
  function (tokens, idx, options, _env, self) {
    return self.renderToken(tokens, idx, options)
  }
markdown.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx].attrSet('target', '_blank')
  tokens[idx].attrSet('rel', 'noopener noreferrer')
  return renderLinkOpen(tokens, idx, options, env, self)
}

function renderMarkdown(content, showCursor) {
  const html = markdown.render(String(content ?? ''))
  if (!showCursor) return html
  const cursor = '<span class="cursor">▍</span>'
  if (!html) return cursor
  if (/<\/(p|li|h[1-6]|blockquote|td)>\s*$/.test(html)) {
    return html.replace(/<\/(p|li|h[1-6]|blockquote|td)>\s*$/, `${cursor}</$1>`)
  }
  return `${html}${cursor}`
}

const props = defineProps({
  conversation: { type: Object, required: true }
})
const emit = defineEmits(['change'])

const input = ref('')
const isStreaming = ref(false)
const scroller = ref(null)
const PREFERRED_MODEL = 'qwen2.5:7b'
const models = ref([])
const modelsError = ref('')
const model = ref('')
const visibleMessages = computed(() =>
  (props.conversation.messages ?? []).filter((msg) => msg.role !== 'system')
)

function commit(patch) {
  emit('change', { ...props.conversation, ...patch })
}
const canSend = computed(
  () => input.value.trim().length > 0 && !isStreaming.value && model.value.length > 0
)

let streamAbort = null
let streamGeneration = 0
let streamMessages = null

watch(
  () => props.conversation.id,
  () => {
    input.value = ''
  }
)

watch(
  () => props.conversation.messages,
  async () => {
    await nextTick()
    const el = scroller.value
    if (el) el.scrollTop = el.scrollHeight
  },
  { deep: true }
)

onMounted(() => {
  loadModels()
})

onUnmounted(() => {
  streamAbort?.abort()
})

async function loadModels() {
  try {
    const response = await fetch(`${BFF_ORIGIN}/api/models`)
    if (!response.ok) throw new Error(`模型列表 ${response.status}`)
    const data = await response.json()
    models.value = Array.isArray(data.models) ? data.models : []
    modelsError.value = ''
    const preferred = models.value.find((item) => item.name === PREFERRED_MODEL)
    model.value = preferred?.name || models.value[0]?.name || ''
  } catch (error) {
    models.value = []
    model.value = ''
    modelsError.value = '模型服务未启动'
    console.error(error)
  }
}

function patchAssistant(patch) {
  if (!streamMessages) return
  const messages = streamMessages.slice()
  const last = messages[messages.length - 1]
  if (!last || last.role !== 'assistant') return
  messages[messages.length - 1] = { ...last, ...patch }
  streamMessages = messages
  commit({ messages })
}

function applyStreamEvent(generation, conversationId, event) {
  if (generation !== streamGeneration || props.conversation.id !== conversationId) return
  if (event.type === 'summary') {
    commit({ summary: event.summary, summarizedCount: event.summarizedCount })
    return
  }
  if (event.type === 'tool') {
    const last = streamMessages?.[streamMessages.length - 1]
    if (!last || last.role !== 'assistant') return
    const queries = (last.queries ?? []).slice()
    if (event.status === 'running') {
      queries.push({ name: event.name, label: event.label, status: 'running' })
    } else {
      const current = queries.find((item) => item.name === event.name && item.status === 'running')
      if (current) current.status = 'done'
    }
    patchAssistant({ queries })
    return
  }
  if (event.type === 'sources') {
    patchAssistant({ sources: event.sources ?? [] })
    return
  }
  if (event.type === 'done' && event.title) {
    commit({ title: event.title })
    return
  }
  if (event.type === 'chunk' && event.content) {
    const last = streamMessages?.[streamMessages.length - 1]
    if (last && last.role === 'assistant') {
      patchAssistant({ content: last.content + event.content })
    }
    return
  }
  if (event.type === 'error') {
    console.error(event.message)
    const last = streamMessages?.[streamMessages.length - 1]
    if (last && last.role === 'assistant' && !last.content) {
      patchAssistant({ content: String(event.message), error: true })
    }
  }
}

async function sendMessage() {
  const text = input.value.trim()
  if (!text || isStreaming.value) return

  const generation = ++streamGeneration
  const conversationId = props.conversation.id
  const controller = new AbortController()
  streamAbort = controller
  streamMessages = [
    ...props.conversation.messages,
    { role: 'user', content: text },
    { role: 'assistant', content: '' }
  ]
  commit({
    title:
      props.conversation.title === DEFAULT_TITLE ? text.slice(0, 18) : props.conversation.title,
    messages: streamMessages
  })
  input.value = ''
  isStreaming.value = true

  try {
    const response = await fetch(`${BFF_ORIGIN}/api/conversations/${conversationId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: text, model: model.value }),
      signal: controller.signal
    })
    if (!response.ok || !response.body) {
      const data = await response.json().catch(() => ({}))
      throw new Error(data.message || `发送失败 ${response.status}`)
    }
    await readSse(response, (event) => applyStreamEvent(generation, conversationId, event))
  } catch (err) {
    if (err.name === 'AbortError' || generation !== streamGeneration) return
    console.error(err)
    applyStreamEvent(generation, conversationId, { type: 'error', message: String(err) })
  } finally {
    if (generation === streamGeneration) {
      isStreaming.value = false
      streamAbort = null
      streamMessages = null
    }
  }
}

function dropEmptyAssistant() {
  const messages = props.conversation.messages
  const last = messages[messages.length - 1]
  if (last?.role === 'assistant' && !last.content) {
    commit({ messages: messages.slice(0, -1) })
  }
}

async function stopStreaming() {
  if (!isStreaming.value) return
  streamGeneration += 1
  isStreaming.value = false
  dropEmptyAssistant()
  streamAbort?.abort()
  streamAbort = null
}

defineExpose({ isStreaming, stopStreaming })
</script>

<style scoped>
.chat {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  height: 100%;
  background: #16161a;
  color: rgba(255, 255, 245, 0.88);
}

.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px 14px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}

.topbar h1 {
  font-size: 15px;
  font-weight: 600;
  line-height: 1.2;
}

select {
  margin-top: 4px;
  max-width: 220px;
  border: 0;
  outline: none;
  background: transparent;
  color: rgba(235, 235, 245, 0.62);
  font: inherit;
  font-size: 12px;
}

select:disabled {
  opacity: 0.45;
}

.status {
  font-size: 12px;
  color: rgba(235, 235, 245, 0.62);
  padding: 4px 10px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.05);
}

.status.busy {
  color: #d5e2ff;
  background: rgba(80, 122, 255, 0.2);
}

.messages {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.messages::-webkit-scrollbar {
  width: 8px;
}

.messages::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.12);
  border-radius: 8px;
}

.empty {
  margin: auto;
  text-align: center;
}

.empty p {
  font-size: 16px;
  font-weight: 600;
}

.empty span {
  display: block;
  margin-top: 6px;
  font-size: 13px;
  color: rgba(235, 235, 245, 0.45);
}

.row {
  display: flex;
}

.row.user {
  justify-content: flex-end;
}

.bubble {
  max-width: min(78%, 640px);
  padding: 10px 14px;
  border-radius: 16px;
  line-height: 1.55;
}

.text {
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.queries {
  margin-bottom: 8px;
}

.queries p {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: rgba(235, 235, 245, 0.62);
}

.sources {
  margin-top: 10px;
  padding-top: 8px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
}

.sources-label {
  display: block;
  margin-bottom: 6px;
  font-size: 11px;
  letter-spacing: 0.06em;
  color: rgba(235, 235, 245, 0.45);
}

.sources ul {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.sources li {
  display: flex;
  align-items: baseline;
  gap: 10px;
}

.source-title {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  line-height: 1.45;
  color: rgba(213, 226, 255, 0.92);
}

.source-date {
  flex: none;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: rgba(235, 235, 245, 0.42);
}

.user .bubble {
  background: #3c6df0;
  color: #fff;
  border-bottom-right-radius: 5px;
}

.assistant .bubble {
  background: #26262d;
  color: rgba(255, 255, 245, 0.9);
  border-bottom-left-radius: 5px;
}

.md :deep(> :first-child) {
  margin-top: 0;
}

.md :deep(> :last-child) {
  margin-bottom: 0;
}

.md :deep(p),
.md :deep(ul),
.md :deep(ol),
.md :deep(pre),
.md :deep(blockquote) {
  margin: 0.65em 0;
}

.md :deep(h1),
.md :deep(h2),
.md :deep(h3),
.md :deep(h4) {
  margin: 0.8em 0 0.35em;
  font-size: 15px;
  font-weight: 650;
  line-height: 1.35;
}

.md :deep(ul),
.md :deep(ol) {
  padding-left: 1.25em;
}

.md :deep(ol) {
  list-style: decimal;
}

.md :deep(ul) {
  list-style: disc;
}

.md :deep(ul ul) {
  list-style: circle;
}

.md :deep(li + li) {
  margin-top: 0.25em;
}

.md :deep(li > p) {
  margin: 0;
}

.md :deep(strong) {
  font-weight: 650;
  color: #fff;
}

.md :deep(a) {
  color: #9eb6ff;
  text-decoration: underline;
  text-underline-offset: 2px;
}

.md :deep(code) {
  padding: 0.1em 0.35em;
  border-radius: 5px;
  background: rgba(255, 255, 255, 0.08);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.92em;
}

.md :deep(pre) {
  padding: 10px 12px;
  overflow-x: auto;
  border-radius: 10px;
  background: #16161a;
}

.md :deep(pre code) {
  padding: 0;
  background: transparent;
}

.md :deep(blockquote) {
  margin-left: 0;
  padding-left: 10px;
  border-left: 2px solid rgba(158, 182, 255, 0.55);
  color: rgba(235, 235, 245, 0.72);
}

.md :deep(.cursor) {
  animation: blink 1s step-end infinite;
}

@keyframes blink {
  50% {
    opacity: 0;
  }
}

.composer {
  display: flex;
  gap: 8px;
  margin: 0 16px 16px;
  padding: 8px 8px 8px 16px;
  background: #222228;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 16px;
}

.composer:focus-within {
  border-color: rgba(120, 154, 255, 0.55);
}

input {
  flex: 1;
  min-width: 0;
  border: 0;
  outline: none;
  background: transparent;
  color: inherit;
  font: inherit;
  padding: 8px 0;
}

input::placeholder {
  color: rgba(235, 235, 245, 0.35);
}

button {
  border: 0;
  border-radius: 12px;
  padding: 0 16px;
  background: #eceae4;
  color: #1b1b1f;
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}

button.stop {
  background: transparent;
  color: rgba(255, 255, 245, 0.88);
  border: 1px solid rgba(255, 255, 255, 0.16);
}

button:disabled {
  opacity: 0.35;
  cursor: default;
}
</style>
