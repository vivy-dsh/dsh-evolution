import { registerComponentInternal } from '../../_shared/ipc.mjs'

/**
 * Loopback-only intake used by other components (the continual harness hands
 * over cross-domain candidates here). Kept separate from the console API so
 * Evolution has exactly one write entry point per record kind, and the store
 * stays lazy: registering the endpoint opens nothing.
 */
export function registerEvolutionInternal(ctx, home, store, dream) {
  return registerComponentInternal(ctx, { home, name: 'evolution', handle: async ({ method, path, body }) => {
      if (dream && path.startsWith('/dream/')) {
        const action = path.slice('/dream/'.length)
        if (['status', 'config', 'request', 'authorize', 'claim', 'evidence', 'plan', 'execute', 'baseline'].includes(action)) return dream[action](body ?? {})
      }
      if (method === 'POST' && path === '/evidence') return store.recordEvidence(body ?? {})
    if (method === 'POST' && path === '/proposal') {
      return body?.proposalId ? store.advanceProposal(body) : store.upsertProposal(body ?? {})
    }
    throw new Error('Unknown evolution component operation')
  } })
}
