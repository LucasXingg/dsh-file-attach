/**
 * Resolve whether the session's current model declares image (visual) input.
 *
 * Matches DSH's host preflight: latest `request/header` config, then agent
 * options; `inputModalities` must explicitly include `image`. Unknown,
 * unresolved, or failed lookups are not visual — the plugin extract path
 * remains the fallback.
 */

import { modelSupportsVisual } from './ingest.js'

/**
 * Provider/model the session will send next.
 * @returns `{ provider, model }` or undefined when neither header nor options name a route.
 */
export function routeFromAgent(agent) {
  const routed = typeof agent?.session?.requestHeader === 'function'
    ? agent.session.requestHeader()?.config
    : undefined
  const provider = routed?.provider ?? agent?.options?.provider
  const model = routed?.model ?? agent?.options?.model
  if (typeof provider !== 'string' || provider === '' || typeof model !== 'string' || model === '') {
    return undefined
  }
  return { provider, model }
}

/**
 * Ask the LLM catalog whether this session's current model accepts images.
 * @param ctx - cordis context with optional `agents` and `llm`.
 * @param sessionId - live session id.
 * @param hinted - optional UI-selected route (composer model seat). Wins over
 *   request/header and agent options so a switch that has not yet produced a
 *   turn still routes images correctly.
 * @returns `{ visual, provider?, model? }`. `visual` is true only on an explicit image declaration.
 */
export async function resolveSessionVisual(ctx, sessionId, hinted) {
  const agent = ctx?.get?.('agents')?.get?.(sessionId)
  const hintedRoute = hintedRouteOf(hinted)
  const route = hintedRoute ?? routeFromAgent(agent)
  const llm = ctx?.get?.('llm')
  if (route === undefined || llm == null || typeof llm.resolveModelInfo !== 'function') {
    return { visual: false }
  }
  try {
    const info = await llm.resolveModelInfo(route.provider, route.model)
    return {
      visual: modelSupportsVisual(info),
      provider: route.provider,
      model: route.model,
    }
  } catch {
    return { visual: false, provider: route.provider, model: route.model }
  }
}

function hintedRouteOf(hinted) {
  const provider = typeof hinted?.provider === 'string' ? hinted.provider.trim() : ''
  const model = typeof hinted?.model === 'string' ? hinted.model.trim() : ''
  if (provider === '' || model === '') return undefined
  return { provider, model }
}
