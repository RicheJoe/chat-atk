// index.js
import express from 'express'
import { conversationsRouter } from './routes/conversations.js'
import { modelsRouter } from './routes/models.js'

export function startBff(port = 8787) {
  const app = express()
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS')
    if (req.method === 'OPTIONS') {
      res.sendStatus(204)
      return
    }
    next()
  })
  app.use(express.json({ limit: '1mb' }))
  app.use('/api', modelsRouter)
  app.use('/api/conversations', conversationsRouter)

  const server = app.listen(port, '127.0.0.1')
  return new Promise((resolve, reject) => {
    server.once('listening', () => {
      console.log(`BFF http://127.0.0.1:${port}`)
      resolve(server)
    })
    server.once('error', (error) => {
      console.error(`BFF 监听 ${port} 失败:`, error)
      reject(error)
    })
  })
}
