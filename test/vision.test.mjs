import test from 'node:test'
import assert from 'node:assert/strict'
import { modelSupportsVisual } from '../lib/ingest.js'
import { routeFromAgent, resolveSessionVisual } from '../lib/vision.js'

test('routeFromAgent prefers request/header over agent options', () => {
  const agent = {
    options: { provider: 'opt', model: 'opt-model' },
    session: {
      requestHeader: () => ({ config: { provider: 'hdr', model: 'hdr-model' } }),
    },
  }
  assert.deepEqual(routeFromAgent(agent), { provider: 'hdr', model: 'hdr-model' })
  assert.deepEqual(routeFromAgent({ options: { provider: 'opt', model: 'opt-model' }, session: {} }), {
    provider: 'opt',
    model: 'opt-model',
  })
  assert.equal(routeFromAgent({ options: {}, session: {} }), undefined)
})

test('resolveSessionVisual is true only when the catalog lists image input', async () => {
  const agent = {
    options: { provider: 'deepseek', model: 'vision' },
    session: { requestHeader: () => undefined },
  }
  const visualLlm = {
    resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }),
  }
  const textLlm = {
    resolveModelInfo: async () => ({ inputModalities: ['text'] }),
  }
  const unknownLlm = {
    resolveModelInfo: async () => ({ id: 'vision' }),
  }
  const ctxOf = (llm) => ({
    get: (name) => {
      if (name === 'agents') return { get: (id) => (id === 's1' ? agent : undefined) }
      if (name === 'llm') return llm
      return undefined
    },
  })
  assert.deepEqual(await resolveSessionVisual(ctxOf(visualLlm), 's1'), {
    visual: true,
    provider: 'deepseek',
    model: 'vision',
  })
  assert.equal((await resolveSessionVisual(ctxOf(textLlm), 's1')).visual, false)
  assert.equal((await resolveSessionVisual(ctxOf(unknownLlm), 's1')).visual, false)
  assert.equal((await resolveSessionVisual(ctxOf(visualLlm), 'missing')).visual, false)
  assert.equal(modelSupportsVisual({ inputModalities: ['text', 'image'] }), true)
})

test('resolveSessionVisual prefers a hinted UI selection over agent options', async () => {
  const agent = {
    options: { provider: 'deepseek', model: 'flash' },
    session: { requestHeader: () => undefined },
  }
  const llm = {
    resolveModelInfo: async (provider, model) => ({
      provider,
      id: model,
      inputModalities: model.includes('vision') ? ['text', 'image'] : ['text'],
    }),
  }
  const ctx = {
    get: (name) => {
      if (name === 'agents') return { get: () => agent }
      if (name === 'llm') return llm
      return undefined
    },
  }
  assert.equal((await resolveSessionVisual(ctx, 's1')).visual, false)
  assert.deepEqual(
    await resolveSessionVisual(ctx, 's1', { provider: 'deepseek', model: 'flash-vision' }),
    { visual: true, provider: 'deepseek', model: 'flash-vision' },
  )
})
