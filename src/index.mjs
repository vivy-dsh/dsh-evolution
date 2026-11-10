/** Host half of the evolution console: read-only harness views, profile config edits, the record store. */
import { isAbsolute } from 'node:path'
import { registerEvolutionHttp } from './http.mjs'
import { registerEvolutionInternal } from './internal.mjs'
import { createLazyEvolutionStore } from './records.mjs'
import { callComponent } from '../../_shared/ipc.mjs'
import { createDreamService, startDreamOnce } from './dream.mjs'

export const name = 'dsh-evolution'
export const inject = ['webServer', 'connection', 'configEditor', 'workspaceRegistry', 'sessionPersistence', 'appReady']

/**
 * Mount the evolution management API.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  const dshHome = process.env.DSH_HOME
  if (!dshHome || !isAbsolute(dshHome)) {
    throw new Error('dsh-evolution requires an absolute DSH_HOME (set by the local profile launcher)')
  }
  // Lazy on purpose: applying the plugin must not import sqlite, create a directory or open a file.
  const store = createLazyEvolutionStore({ env: process.env, home: dshHome, webServer: ctx.webServer })
  // Knowledge assets are written only by their owner; Evolution goes through the component IPC, never the file.
  const publishOwner = {
    commit: body => callComponent({ home: dshHome, name: 'mempalace', path: '/knowledge/commit', body }),
    status: body => callComponent({ home: dshHome, name: 'mempalace', path: '/knowledge/status', body }),
    rollback: body => callComponent({ home: dshHome, name: 'mempalace', path: '/knowledge/rollback', body }),
  }
  const dream = createDreamService({ home: dshHome, ctx })
  startDreamOnce(ctx, dream)
  const disposeHttp = registerEvolutionHttp(ctx, { dshHome, store, publishOwner, dream })
  // Cross-domain candidates arrive over the same loopback component channel the
  // console already publishes to; nothing here opens the database either.
  const disposeInternal = registerEvolutionInternal(ctx, dshHome, store, dream)
  ctx.effect(() => () => {
    disposeInternal()
    disposeHttp()
    return store.close()
  }, 'dsh-evolution: dispose component IPC, HTTP API and record store')
}

export default { name, inject, apply }
