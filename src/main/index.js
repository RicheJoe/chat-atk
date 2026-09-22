import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { Ollama } from 'ollama'
const ollama = new Ollama({
  host: 'http://127.0.0.1:11434'
})
function createWindow() {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 900,
    height: 670,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // IPC test
  ipcMain.on('ping', () => console.log('pong'))

  createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.

const chatSessions = new Map()
const abortedRequestIds = new Set()

function isAbortError(error) {
  return error?.name === 'AbortError' || error?.code === 'ABORT_ERR'
}

function sendToRenderer(sender, channel, payload) {
  if (!sender.isDestroyed()) {
    sender.send(channel, payload)
  }
}

// 渲染进程点“停止”时，按 requestId 中断对应的 Ollama 流
ipcMain.handle('ollama-abort', (_event, requestId) => {
  abortedRequestIds.add(requestId)
  const session = chatSessions.get(requestId)
  if (session) {
    session.aborted = true
    session.stream?.abort()
  }
  return { success: true }
})

// 核心：监听渲染进程的对话请求，流式转发给 Ollama，并逐块回传
ipcMain.handle('ollama-chat', async (event, { requestId, model, messages }) => {
  if (abortedRequestIds.has(requestId)) {
    abortedRequestIds.delete(requestId)
    sendToRenderer(event.sender, 'ollama-done', { requestId, aborted: true })
    return { success: true, aborted: true }
  }

  const session = { requestId, aborted: false, stream: null }
  chatSessions.set(requestId, session)

  try {
    const stream = await ollama.chat({
      model,
      messages,
      stream: true
    })
    session.stream = stream

    if (session.aborted) {
      stream.abort()
    }

    for await (const chunk of stream) {
      if (session.aborted) {
        stream.abort()
        break
      }
      const content = chunk.message?.content
      if (content) {
        sendToRenderer(event.sender, 'ollama-chunk', { requestId, content })
      }
    }

    sendToRenderer(event.sender, 'ollama-done', { requestId, aborted: session.aborted })
    return { success: true, aborted: session.aborted }
  } catch (error) {
    if (session.aborted || isAbortError(error)) {
      sendToRenderer(event.sender, 'ollama-done', { requestId, aborted: true })
      return { success: true, aborted: true }
    }
    sendToRenderer(event.sender, 'ollama-error', { requestId, error: String(error) })
    return { success: false, error: String(error) }
  } finally {
    chatSessions.delete(requestId)
    abortedRequestIds.delete(requestId)
  }
})
