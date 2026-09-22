<template>
  <div class="chat">
    <header class="topbar">
      <div>
        <h1>本地对话</h1>
        <p>{{ model }}</p>
      </div>
      <span class="status" :class="{ busy: isStreaming }">
        {{ isStreaming ? '生成中' : '就绪' }}
      </span>
    </header>

    <div ref="scroller" class="messages">
      <div v-if="messages.length === 0" class="empty">
        <p>发一条消息，开始对话</p>
        <span>回复由本机 Ollama 生成</span>
      </div>
      <div v-for="(msg, i) in messages" :key="i" :class="['row', msg.role]">
        <div class="bubble">
          {{ msg.content
          }}<span v-if="isStreaming && i === messages.length - 1" class="cursor">▍</span>
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

const input = ref('')
const messages = ref([])
const isStreaming = ref(false)
const scroller = ref(null)
const model = 'qwen2.5:7b'
const canSend = computed(() => input.value.trim().length > 0 && !isStreaming.value)

let stopListening = () => {}
let nextRequestId = 0
let streamingRequestId = 0

watch(
  messages,
  async () => {
    await nextTick()
    const el = scroller.value
    if (el) el.scrollTop = el.scrollHeight
  },
  { deep: true }
)

onMounted(() => {
  if (!window.ollamaApi) return
  const offs = [
    window.ollamaApi.onChunk(({ requestId, content }) => {
      if (requestId !== streamingRequestId || !content) return
      const last = messages.value[messages.value.length - 1]
      if (last && last.role === 'assistant') {
        last.content += content
      }
    }),
    window.ollamaApi.onDone(({ requestId }) => {
      if (requestId !== streamingRequestId) return
      isStreaming.value = false
    }),
    window.ollamaApi.onError(({ requestId, error }) => {
      if (requestId !== streamingRequestId) return
      console.error('Ollama error:', error)
      const last = messages.value[messages.value.length - 1]
      if (last && last.role === 'assistant' && !last.content) {
        last.content = String(error)
      }
      isStreaming.value = false
    })
  ]

  stopListening = () => offs.forEach((off) => off?.())
})

onUnmounted(() => {
  stopListening()
  if (isStreaming.value && window.ollamaApi) {
    window.ollamaApi.abort(streamingRequestId)
  }
})

async function sendMessage() {
  const text = input.value.trim()
  if (!text || isStreaming.value) return

  const requestId = ++nextRequestId
  streamingRequestId = requestId
  messages.value.push({ role: 'user', content: text })
  messages.value.push({ role: 'assistant', content: '' })
  input.value = ''
  isStreaming.value = true

  const history = messages.value
    .slice(0, -1)
    .map((msg) => ({ role: msg.role, content: msg.content }))

  try {
    await window.ollamaApi.chat(requestId, model, history)
  } catch (err) {
    if (requestId !== streamingRequestId) return
    console.error('Ollama error:', err)
    const last = messages.value[messages.value.length - 1]
    if (last && last.role === 'assistant' && !last.content) {
      last.content = String(err)
    }
  } finally {
    if (requestId === streamingRequestId) {
      isStreaming.value = false
    }
  }
}

function dropEmptyAssistant() {
  const last = messages.value[messages.value.length - 1]
  if (last?.role === 'assistant' && !last.content) {
    messages.value.pop()
  }
}

async function stopStreaming() {
  if (!isStreaming.value || !window.ollamaApi) return
  const requestId = streamingRequestId
  streamingRequestId = 0
  isStreaming.value = false
  dropEmptyAssistant()
  try {
    await window.ollamaApi.abort(requestId)
  } catch (err) {
    console.error('停止生成失败:', err)
  }
}
</script>

<style scoped>
.chat {
  display: flex;
  flex-direction: column;
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

.topbar p {
  margin-top: 2px;
  font-size: 12px;
  color: rgba(235, 235, 245, 0.48);
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
