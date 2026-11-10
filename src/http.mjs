/** Same-origin HTTP API for the evolution console. */
import { join } from 'node:path'
import {
  EvolutionError,
  KINDS,
  assertSessionKey,
  countEntries,
  emptyState,
  entrySummary,
  fileSizes,
  findEntry,
  latestActivity,
  listEntries,
  listSessions,
  readBenchmark,
  readHarnessState,
  readJsonlTail,
  readReviews,
  readSession,
  resolveHarnessPaths,
  stripHistory,
} from './harness.mjs'
import { applyConfig, readConfig, resetConfig } from './config.mjs'
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT, RECORD_KINDS } from './records.mjs'

const prefix = '/dsh-evolution/api'
const DEFAULT_BODY_LIMIT = 256 * 1024

/** Record store codes → HTTP status, so an operator sees the refusal the library meant. */
const RECORD_STATUS = {
  EVOLUTION_DREAM_REFUSED: 422,
  EVOLUTION_SQLITE_UNAVAILABLE: 503,
  EVOLUTION_STORE_UNAVAILABLE: 503,
  SUBJECT_UNAVAILABLE: 503,
  EVOLUTION_STORE_FOREIGN: 409,
  EVOLUTION_SCHEMA_UNSUPPORTED: 409,
  EVOLUTION_APPEND_ONLY: 409,
  EVOLUTION_CONFLICT: 409,
  EVOLUTION_VALIDATION_CONSUMED: 409,
  EVOLUTION_EVIDENCE_CONFLICT: 409,
  EVOLUTION_SUBJECT_MISMATCH: 409,
  EVOLUTION_ALREADY_LIVE: 409,
  EVOLUTION_TICKET_MISMATCH: 409,
  EVOLUTION_NOT_FOUND: 404,
  EVOLUTION_INVALID_RECORD: 422,
  EVOLUTION_TICKET_REQUIRED: 422,
  EVOLUTION_UNKNOWN_EVIDENCE: 422,
  EVOLUTION_UNKNOWN_PROPOSAL: 422,
  EVOLUTION_STALE_VALIDATION: 422,
  EVOLUTION_VALIDATION_REQUIRED: 422,
  EVOLUTION_VALIDATION_INSUFFICIENT: 422,
  EVOLUTION_OWNER_UNSUPPORTED: 422,
  EVOLUTION_OWNER_REF_REQUIRED: 422,
  EVOLUTION_OWNER_API_REQUIRED: 409,
  EVOLUTION_OWNER_FAILED: 502,
  EVOLUTION_ROLLBACK_TARGET_INVALID: 422,
  EVOLUTION_SOURCE_NOT_ALLOWED: 422,
  EVOLUTION_DERIVED_INSUFFICIENT: 422,
  EVOLUTION_LIMIT_EXCEEDED: 413,
  EVOLUTION_STATE_CORRUPT: 500,
}

function send(res, status, value) {
  if (res.writableEnded || res.destroyed) return
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}

function allowedHost(host) {
  const value = String(host ?? '').toLowerCase()
  return /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(value)
}

async function readBody(req, limit = DEFAULT_BODY_LIMIT) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += Buffer.byteLength(chunk)
    if (size > limit) {
      const error = new Error(`请求体超过 ${Math.round(limit / 1024)} KB 上限`)
      error.status = 413
      throw error
    }
    chunks.push(Buffer.from(chunk))
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text.trim()) return {}
  try {
    return JSON.parse(text)
  } catch {
    const error = new Error('请求体不是合法 JSON')
    error.status = 400
    throw error
  }
}

function integer(value, fallback, max) {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed) || parsed < 1) return fallback
  return max === undefined ? parsed : Math.min(parsed, max)
}

function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function requireJson(req, fail) {
  if (!String(req.headers['content-type'] ?? '').toLowerCase().includes('application/json')) {
    fail(415, 'JSON_REQUIRED', '请求必须使用 JSON', '刷新页面后重试')
    return false
  }
  return true
}

/** Query strings and other agents prefer snake_case; the record API speaks camelCase. */
function toCamel(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return {}
  const out = {}
  for (const [key, value] of Object.entries(body)) {
    out[key.replace(/_+([a-z0-9])/gi, (_, char) => char.toUpperCase())] = value
  }
  return out
}

/** `limit`/`offset` for the record queries, clamped to the same ceiling the store uses. */
function pageOf(query) {
  return {
    limit: integer(query.get('limit'), DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT),
    offset: integer(query.get('offset'), 0),
  }
}

function optionalText(query, name) {
  return text(query.get(name)) || undefined
}

function errorStatus(error) {
  if (error?.status) return error.status
  if (error?.code && RECORD_STATUS[error.code]) return RECORD_STATUS[error.code]
  switch (error?.code) {
    case 'EVOLUTION_UNAVAILABLE': return 409
    case 'INVALID_SESSION':
    case 'INVALID_FIELD':
    case 'INVALID_KIND': return 400
    case 'STATE_INVALID':
    case 'FILE_TOO_LARGE':
    case 'CONFIG_UNAVAILABLE':
    case 'CONFIG_REJECTED': return 422
    default: return 500
  }
}

async function statusSnapshot(paths) {
  const base = {
    installed: paths.installed,
    active: paths.active,
    documentPath: paths.documentPath,
    harnessRoot: paths.harnessRoot,
    skillsDir: paths.skillsDir,
    entries: 0,
    lastActivity: null,
    writable: paths.active,
  }
  if (!paths.installed) return { ...base, error: '未找到 continual-harness 配置条目' }
  try {
    const state = await readHarnessState(paths.harnessRoot)
    const history = await readJsonlTail(join(paths.harnessRoot, 'refinements.jsonl'), 1)
    return { ...base, entries: countEntries(state), lastActivity: latestActivity(state, history) }
  } catch (error) {
    return { ...base, error: error instanceof Error ? error.message : String(error) }
  }
}

async function overviewSnapshot(paths, recordStore) {
  const status = await statusSnapshot(paths)
  const root = paths.harnessRoot
  let state = emptyState()
  let stateError = null
  try { state = await readHarnessState(root) } catch (error) {
    stateError = error instanceof Error ? error.message : String(error)
  }
  const summary = entrySummary(state)
  const history = await readJsonlTail(join(root, 'refinements.jsonl'), 8)
  const reviews = await readReviews(root, 8)
  const benchmark = await readBenchmark(root, 8)
  const files = await fileSizes(root)
  const sessions = await listSessions(root)
  return {
    ...status,
    ...summary,
    historyTotal: state.refinements.length,
    stateError,
    recentHistory: stripHistory(history),
    recentReviews: reviews,
    benchmark: {
      cases: benchmark.cases.length,
      frozen: benchmark.cases.filter(item => item.state === 'frozen').length,
      runs: benchmark.runs.length,
      recent: benchmark.runs.slice(0, 5),
      casesError: benchmark.casesError,
    },
    files,
    sessions: { count: sessions.length, lastActivity: sessions[0]?.updatedAt ?? null },
    evolution: await recordStore.summarySafe(),
  }
}

/**
 * Register the evolution management API.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ dshHome: string, store: object, publishOwner?: object }} options the store handle is lazy: nothing opens until a route needs it
 */
export function registerEvolutionHttp(ctx, { dshHome, store, publishOwner, dream }) {
  return ctx.webServer.register({
    kind: 'prefix',
    path: prefix,
    handler: async (req, res) => {
      const fail = (status, code, error, hint) => send(res, status, { ok: false, code, error, ...(hint ? { hint } : {}) })
      if (!allowedHost(req.headers.host)) {
        return fail(403, 'HOST_REJECTED', '只接受本机访问', '在本地 DSH 面板中打开进化页面')
      }
      if (req.method !== 'GET' && req.headers.origin) {
        let same = false
        try { same = new URL(req.headers.origin).host.toLowerCase() === String(req.headers.host).toLowerCase() } catch { /* malformed origin */ }
        if (!same) return fail(403, 'ORIGIN_REJECTED', '跨站请求被拒绝', '在 DSH 面板内重试')
      }
      const conn = ctx.get('connection')
      if (!conn || typeof conn.requestRejection !== 'function') {
        return fail(503, 'AUTH_UNAVAILABLE', '会话验证不可用', '检查 DSH 连接服务是否已组合')
      }
      const rejection = conn.requestRejection(req)
      if (rejection !== undefined && rejection !== null && rejection !== false) {
        return fail(typeof rejection === 'number' ? rejection : 403, 'AUTH_REJECTED', '会话未通过验证', '重新打开本地面板链接')
      }

      const url = new URL(req.url, 'http://127.0.0.1')
      const route = url.pathname.slice(prefix.length)
      const query = url.searchParams
      try {
        const paths = () => resolveHarnessPaths(ctx, dshHome)

        if (dream && route === '/dream' && req.method === 'GET') return send(res, 200, await dream.status())
        if (dream && ['/dream/config', '/dream/requests', '/dream/refine'].includes(route) && req.method === 'POST') {
          if (!requireJson(req, fail)) return
          const body = await readBody(req)
          // Browser callers can request manual refinement only; automatic admission is startup-owned.
          return send(res, 200, route === '/dream/config' ? await dream.config(body.patch ?? body) : await dream.request({ ...body, mode: 'manual' }))
        }

        if (route === '/status' && req.method === 'GET') {
          return send(res, 200, { ok: true, ...await statusSnapshot(paths()) })
        }

        if (route === '/overview' && req.method === 'GET') {
          return send(res, 200, { ok: true, snapshot: await overviewSnapshot(paths(), store) })
        }

        if (route === '/entries' && req.method === 'GET') {
          const kind = text(query.get('kind'))
          if (kind && !KINDS.includes(kind)) return fail(400, 'INVALID_KIND', `未知条目类型 ${kind}`)
          const current = paths()
          const state = await readHarnessState(current.harnessRoot)
          const items = listEntries(state, { kind, q: text(query.get('q')) })
          return send(res, 200, { ok: true, items, total: items.length })
        }

        if (route === '/entry' && req.method === 'GET') {
          const kind = text(query.get('kind'))
          const id = text(query.get('id'))
          if (!KINDS.includes(kind) || !id) return fail(400, 'INVALID_KIND', '需要合法的 kind 与 id')
          const state = await readHarnessState(paths().harnessRoot)
          const entry = findEntry(state, kind, id)
          if (!entry) return fail(404, 'ENTRY_NOT_FOUND', '条目不存在或已被删除')
          return send(res, 200, { ok: true, entry })
        }

        if (route === '/history' && req.method === 'GET') {
          const limit = integer(query.get('limit'), 100, 500)
          const records = await readJsonlTail(join(paths().harnessRoot, 'refinements.jsonl'), limit)
          const items = stripHistory(records)
          return send(res, 200, { ok: true, items, total: items.length })
        }

        if (route === '/sessions' && req.method === 'GET') {
          return send(res, 200, { ok: true, items: await listSessions(paths().harnessRoot) })
        }

        if (route === '/session' && req.method === 'GET') {
          const key = assertSessionKey(text(query.get('key')))
          return send(res, 200, { ok: true, ...await readSession(paths().harnessRoot, key) })
        }

        if (route === '/reviews' && req.method === 'GET') {
          const limit = integer(query.get('limit'), 100, 500)
          const items = await readReviews(paths().harnessRoot, limit)
          return send(res, 200, { ok: true, items, total: items.length })
        }

        if (route === '/benchmark' && req.method === 'GET') {
          const limit = integer(query.get('limit'), 50, 200)
          return send(res, 200, { ok: true, ...await readBenchmark(paths().harnessRoot, limit) })
        }

        if (route === '/config' && req.method === 'GET') {
          try {
            return send(res, 200, { ok: true, ...readConfig(ctx, dshHome) })
          } catch (error) {
            throw new EvolutionError('CONFIG_UNAVAILABLE', error instanceof Error ? error.message : String(error), '检查 profile 的 cordis.patch.yml 是否有效')
          }
        }

        if (route === '/config' && req.method === 'POST') {
          if (!requireJson(req, fail)) return
          const body = await readBody(req)
          if (!body || typeof body.patch !== 'object' || body.patch === null || Array.isArray(body.patch)) {
            return fail(400, 'INVALID_FIELD', '请求需要 { patch: object }')
          }
          if (Object.keys(body.patch).length === 0) return send(res, 200, { ok: true, changed: false })
          try {
            await applyConfig(ctx, body.patch)
          } catch (error) {
            if (error instanceof EvolutionError) throw error
            throw new EvolutionError('CONFIG_REJECTED', error instanceof Error ? error.message : String(error), '检查数值范围与类型后重试')
          }
          return send(res, 200, { ok: true, changed: true })
        }

        if (route === '/config/reset' && req.method === 'POST') {
          if (!requireJson(req, fail)) return
          await readBody(req)
          try {
            await resetConfig(ctx)
          } catch (error) {
            if (error instanceof EvolutionError) throw error
            throw new EvolutionError('CONFIG_REJECTED', error instanceof Error ? error.message : String(error), '检查 profile 的 cordis.patch.yml 后重试')
          }
          return send(res, 200, { ok: true })
        }

        if (route === '/store' && req.method === 'GET') {
          return send(res, 200, { ok: true, ...(await store.status()) })
        }

        if (route === '/summary' && req.method === 'GET') {
          return send(res, 200, { ok: true, ...(await store.summarySafe()) })
        }

        if (route === '/records' && req.method === 'GET') {
          const ticketId = text(query.get('ticket_id'))
          if (!ticketId) {
            return fail(400, 'INVALID_FIELD', '查询进化记录需要 ticket_id',
              '记录按 Superagent 的 Ticket 归组；请带上 ?ticket_id=，或改用 /proposals 浏览')
          }
          const kind = text(query.get('kind'))
          if (kind && !RECORD_KINDS.includes(kind)) {
            return fail(400, 'INVALID_FIELD', `未知记录类型 ${kind}`, `可用类型：${RECORD_KINDS.join('、')}`)
          }
          const group = await store.listByTicket(ticketId, {
            kinds: kind ? [kind] : undefined,
            state: optionalText(query, 'state'),
            limit: integer(query.get('limit'), DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT),
          })
          return send(res, 200, { ok: true, ...group })
        }

        if (route === '/evidence' && req.method === 'GET') {
          return send(res, 200, { ok: true, ...(await store.listEvidence({
            ticketId: optionalText(query, 'ticket_id'),
            source: optionalText(query, 'source'),
            ...pageOf(query),
          })) })
        }

        if (route === '/proposals' && req.method === 'GET') {
          return send(res, 200, { ok: true, ...(await store.listProposals({
            ticketId: optionalText(query, 'ticket_id'),
            state: optionalText(query, 'state'),
            candidateKind: optionalText(query, 'candidate_kind'),
            ownerKind: optionalText(query, 'owner_kind'),
            assetScope: optionalText(query, 'asset_scope'),
            ...pageOf(query),
          })) })
        }

        if (route === '/validations' && req.method === 'GET') {
          return send(res, 200, { ok: true, ...(await store.listValidations({
            proposalId: optionalText(query, 'proposal_id'),
            ticketId: optionalText(query, 'ticket_id'),
            verdict: optionalText(query, 'verdict'),
            ...pageOf(query),
          })) })
        }

        if (route === '/publications' && req.method === 'GET') {
          return send(res, 200, { ok: true, ...(await store.listPublications({
            proposalId: optionalText(query, 'proposal_id'),
            assetScope: optionalText(query, 'asset_scope'),
            ticketId: optionalText(query, 'ticket_id'),
            state: optionalText(query, 'state'),
            purpose: optionalText(query, 'purpose'),
            ...pageOf(query),
          })) })
        }

        if ((route === '/proposal' || route === '/publication') && req.method === 'GET') {
          const record = await store.getRecord(text(query.get('id')), { history: query.get('history') === '1' })
          if (!record) return fail(404, 'EVOLUTION_NOT_FOUND', `找不到记录 ${text(query.get('id')) || '（未提供 id）'}`,
            '请先用 /records 或 /proposals 取到 id')
          return send(res, 200, { ok: true, record })
        }

        if (route === '/verify' && req.method === 'GET') {
          return send(res, 200, { ok: true, verify: await store.verifyHistory({ limit: integer(query.get('limit'), null) }) })
        }

        if (route === '/evidence' && req.method === 'POST') {
          if (!requireJson(req, fail)) return
          return send(res, 200, { ok: true, ...(await store.recordEvidence(toCamel(await readBody(req)))) })
        }

        if (route === '/proposal' && req.method === 'POST') {
          if (!requireJson(req, fail)) return
          const body = toCamel(await readBody(req))
          const written = body.toState === undefined
            ? await store.upsertProposal(body)
            : await store.advanceProposal(body)
          return send(res, 200, { ok: true, ...written })
        }

        if (route === '/validation' && req.method === 'POST') {
          if (!requireJson(req, fail)) return
          return send(res, 200, { ok: true, ...(await store.recordValidation(toCamel(await readBody(req)))) })
        }

        if (route === '/publish' && req.method === 'POST') {
          if (!requireJson(req, fail)) return
          return send(res, 200, { ok: true, ...(await store.publish(toCamel(await readBody(req)))) })
        }

        if (route === '/rollback' && req.method === 'POST') {
          if (!requireJson(req, fail)) return
          return send(res, 200, { ok: true, ...(await store.rollback(toCamel(await readBody(req)))) })
        }

        if (route === '/publish-knowledge' && req.method === 'POST') {
          if (!requireJson(req, fail)) return
          return send(res, 200, { ok: true, ...(await store.publishKnowledge(toCamel(await readBody(req)), publishOwner)) })
        }

        if (route === '/rollback-knowledge' && req.method === 'POST') {
          if (!requireJson(req, fail)) return
          return send(res, 200, { ok: true, ...(await store.rollbackKnowledge(toCamel(await readBody(req)), publishOwner)) })
        }

        return fail(404, 'NOT_FOUND', `未知接口 ${route}`)
      } catch (error) {
        const status = errorStatus(error)
        if (status >= 500) ctx.logger?.warn?.(`dsh-evolution: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
        return fail(status, error?.code || 'EVOLUTION_FAILED', error instanceof Error ? error.message : String(error), error?.hint)
      }
    },
  })
}
