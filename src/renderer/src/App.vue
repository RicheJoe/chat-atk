<script setup>
import { ref, onMounted } from 'vue'
import ChatContent from './components/chatContent.vue'
import { bffJson } from './bffClient'

const conversations = ref([])
const active = ref(null)
const chatRef = ref(null)

function upsert(conversation) {
  const item = {
    id: conversation.id,
    title: conversation.title,
    updatedAt: conversation.updatedAt
  }
  conversations.value = [item, ...conversations.value.filter((entry) => entry.id !== item.id)]
}

function onConversationChange(conversation) {
  if (active.value?.id !== conversation.id) return
  active.value = conversation
  const index = conversations.value.findIndex((item) => item.id === conversation.id)
  if (index === -1) {
    upsert(conversation)
    return
  }
  conversations.value[index] = {
    ...conversations.value[index],
    title: conversation.title
  }
}

async function settleCurrent() {
  if (chatRef.value?.isStreaming) await chatRef.value.stopStreaming()
}

async function openConversation(id) {
  if (active.value?.id === id) return
  await settleCurrent()
  active.value = await bffJson(`/api/conversations/${id}`)
}

async function createNew() {
  await settleCurrent()
  const conversation = await bffJson('/api/conversations', { method: 'POST' })
  upsert(conversation)
  active.value = conversation
}

async function removeConversation(id) {
  const removingActive = active.value?.id === id
  if (removingActive && chatRef.value?.isStreaming) await chatRef.value.stopStreaming()
  await bffJson(`/api/conversations/${id}`, { method: 'DELETE' })
  conversations.value = conversations.value.filter((entry) => entry.id !== id)
  if (!removingActive) return
  if (conversations.value.length === 0) {
    await createNew()
    return
  }
  active.value = await bffJson(`/api/conversations/${conversations.value[0].id}`)
}

onMounted(async () => {
  try {
    conversations.value = await bffJson('/api/conversations')
    if (conversations.value.length === 0) {
      await createNew()
      return
    }
    active.value = await bffJson(`/api/conversations/${conversations.value[0].id}`)
  } catch (error) {
    console.error(error)
  }
})
</script>

<template>
  <div class="shell">
    <aside class="sidebar">
      <button class="new" type="button" @click="createNew">新对话</button>
      <ul>
        <li v-for="item in conversations" :key="item.id">
          <button
            type="button"
            class="item"
            :class="{ current: item.id === active?.id }"
            @click="openConversation(item.id)"
          >
            {{ item.title }}
          </button>
          <button type="button" class="delete" @click.stop="removeConversation(item.id)">
            删除
          </button>
        </li>
      </ul>
    </aside>
    <ChatContent
      v-if="active"
      ref="chatRef"
      :conversation="active"
      @change="onConversationChange"
    />
  </div>
</template>

<style scoped>
.shell {
  display: flex;
  height: 100%;
  background: #16161a;
}

.sidebar {
  width: 220px;
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border-right: 1px solid rgba(255, 255, 255, 0.06);
  background: #121216;
}

.new,
.item,
.delete {
  border: 0;
  font: inherit;
  cursor: pointer;
}

.new {
  border-radius: 12px;
  padding: 8px 12px;
  background: #eceae4;
  color: #1b1b1f;
  font-weight: 600;
}

ul {
  margin: 0;
  padding: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

li {
  display: flex;
  align-items: center;
  gap: 4px;
}

.item {
  flex: 1;
  min-width: 0;
  text-align: left;
  padding: 8px 10px;
  border-radius: 10px;
  background: transparent;
  color: rgba(255, 255, 245, 0.8);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.item.current {
  background: rgba(255, 255, 255, 0.06);
  color: rgba(255, 255, 245, 0.94);
}

.delete {
  flex: none;
  padding: 4px 6px;
  border-radius: 8px;
  background: transparent;
  color: rgba(235, 235, 245, 0.4);
  font-size: 12px;
}

.delete:hover {
  color: rgba(255, 255, 245, 0.86);
}
</style>
