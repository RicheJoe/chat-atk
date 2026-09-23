import { Router } from 'express'
import { getProvider } from '../providers/index.js'

export const modelsRouter = Router()

modelsRouter.get('/models', async (_req, res) => {
  try {
    const models = await getProvider('ollama').listModels()
    res.json({ models })
  } catch (error) {
    res.status(502).json({ message: String(error) })
  }
})
