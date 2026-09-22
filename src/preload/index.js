import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// Custom APIs for renderer
const api = {}

const ollamaApi = {
  chat: (requestId, model, messages) =>
    ipcRenderer.invoke('ollama-chat', { requestId, model, messages }),
  abort: (requestId) => ipcRenderer.invoke('ollama-abort', requestId),
  onChunk: (callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('ollama-chunk', listener)
    return () => ipcRenderer.removeListener('ollama-chunk', listener)
  },
  onDone: (callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('ollama-done', listener)
    return () => ipcRenderer.removeListener('ollama-done', listener)
  },
  onError: (callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('ollama-error', listener)
    return () => ipcRenderer.removeListener('ollama-error', listener)
  }
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
    contextBridge.exposeInMainWorld('ollamaApi', ollamaApi)
  } catch (error) {
    console.error(error)
  }
} else {
  window.electron = electronAPI
  window.api = api
  window.ollamaApi = ollamaApi
}
