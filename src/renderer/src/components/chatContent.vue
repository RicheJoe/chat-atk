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
          {{ msg.content
          }}<span v-if="isStreaming && i === visibleMessages.length - 1" class="cursor">▍</span>
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
import { DEFAULT_TITLE } from '../conversation'
import { BFF_ORIGIN, readSse } from '../bffClient'

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

function applyStreamEvent(generation, conversationId, event) {
  if (generation !== streamGeneration || props.conversation.id !== conversationId) return
  if (event.type === 'summary') {
    commit({ summary: event.summary, summarizedCount: event.summarizedCount })
    return
  }
  if (event.type === 'done' && event.title) {
    commit({ title: event.title })
    return
  }
  if (event.type === 'chunk' && event.content) {
    const messages = props.conversation.messages.slice()
    const last = messages[messages.length - 1]
    if (last && last.role === 'assistant') {
      messages[messages.length - 1] = { ...last, content: last.content + event.content }
      commit({ messages })
    }
    return
  }
  if (event.type === 'error') {
    console.error(event.message)
    const messages = props.conversation.messages.slice()
    const last = messages[messages.length - 1]
    if (last && last.role === 'assistant' && !last.content) {
      messages[messages.length - 1] = { ...last, content: String(event.message), error: true }
      commit({ messages })
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
  commit({
    title:
      props.conversation.title === DEFAULT_TITLE ? text.slice(0, 18) : props.conversation.title,
    messages: [
      ...props.conversation.messages,
      { role: 'user', content: text },
      { role: 'assistant', content: '' }
    ]
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
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  line-height: 1.55;
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

.cursor {
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
