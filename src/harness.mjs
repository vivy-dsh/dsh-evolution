/** Read-only views over a continual-harness data root. */
import { open, readdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'

/** Profile entry id of the continual-harness plugin. */
export const HARNESS_ENTRY_ID = 'continual-harness'
/** Entry kinds stored by the harness state schema. */
export const KINDS = ['prompt', 'memory', 'skill', 'subagent']

const SESSION_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const STATE_MAX_BYTES = 16 * 1024 * 1024
const TAIL_MAX_BYTES = 2 * 1024 * 1024
const CASES_MAX_BYTES = 4 * 1024 * 1024

/** An error carrying a stable code and an optional operator hint. */
export class EvolutionError extends Error {
  /**
   * @param {string} code stable machine code
   * @param {string} message human-readable message
   * @param {string} [hint] recovery hint
   */
  constructor(code, message, hint) {
    super(message)
    this.name = 'EvolutionError'
    this.code = code
    if (hint) this.hint = hint
  }
}

/** Deep-clone JSON data, returning an empty object for undefined. */
export function jsonClone(value) {
  if (value === undefined) return {}
  return JSON.parse(JSON.stringify(value))
}

/** The state a missing `harness_state.json` reads as. */
export function emptyState() {
  return {
    schemaVersion: 1,
    entries: Object.fromEntries(KINDS.map(kind => [kind, {}])),
    refinements: [],
  }
}

/** Coerce an on-disk state document into the shape the views expect. */
export function normalizeState(value) {
  const state = value !== null && typeof value === 'object' ? value : {}
  const entries = {}
  for (const kind of KINDS) {
    const bucket = state.entries?.[kind]
    entries[kind] = bucket !== null && typeof bucket === 'object' && !Array.isArray(bucket) ? bucket : {}
  }
  return {
    schemaVersion: Number.isFinite(state.schemaVersion) ? state.schemaVersion : 1,
    entries,
    refinements: Array.isArray(state.refinements) ? state.refinements : [],
  }
}

async function readText(file, maxBytes) {
  let handle
  try { handle = await open(file, 'r') } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
  try {
    const info = await handle.stat()
    if (info.size > maxBytes) {
      throw new EvolutionError('FILE_TOO_LARGE', `${file} 超过 ${Math.round(maxBytes / 1024 / 1024)} MB 上限`, '清理该文件或在 continual-harness 设置中调整上限')
    }
    const buffer = Buffer.alloc(info.size)
    if (info.size > 0) await handle.read(buffer, 0, info.size, 0)
    return buffer.toString('utf8')
  } finally {
    await handle.close()
  }
}

/** Read `<home>/harness_state.json`; a missing file yields the empty schema. */
export async function readHarnessState(home) {
  const text = await readText(join(home, 'harness_state.json'), STATE_MAX_BYTES)
  if (text === null) return emptyState()
  let parsed
  try { parsed = JSON.parse(text) } catch (error) {
    throw new EvolutionError('STATE_INVALID', `harness_state.json 解析失败：${error.message}`, '检查文件是否被中途写入或手工修改')
  }
  return normalizeState(parsed)
}

/** Read a file's tail, dropping a partial first line when the read was truncated. */
export async function readTail(file, maxBytes = TAIL_MAX_BYTES) {
  let handle
  try { handle = await open(file, 'r') } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
  try {
    const info = await handle.stat()
    const start = Math.max(0, info.size - maxBytes)
    const length = info.size - start
    const buffer = Buffer.alloc(length)
    if (length > 0) await handle.read(buffer, 0, length, start)
    let text = buffer.toString('utf8')
    if (start > 0) {
      const newline = text.indexOf('\n')
      text = newline === -1 ? '' : text.slice(newline + 1)
    }
    return text
  } finally {
    await handle.close()
  }
}

/** Parse the last `limit` JSON lines of an append-only file, skipping corrupt lines. */
export async function readJsonlTail(file, limit = 100, maxBytes = TAIL_MAX_BYTES) {
  const text = await readTail(file, maxBytes)
  if (text === null) return []
  const records = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try { records.push(JSON.parse(line)) } catch { /* one corrupt line never hides the rest */ }
  }
  return Number.isFinite(limit) && limit > 0 ? records.slice(-limit) : records
}

/** Listing metadata for one harness entry. */
export function entryMeta(entry) {
  return {
    id: entry.id,
    kind: entry.kind,
    version: entry.version,
    updatedAt: entry.updatedAt,
    title: entry.title ?? '',
    protection: entry.protection ?? null,
    projects: Array.isArray(entry.projects) ? entry.projects : [],
    blastRadius: entry.blastRadius ?? null,
    metadata: entry.metadata ?? {},
    description: entry.description ?? '',
    contentBytes: Buffer.byteLength(String(entry.content ?? ''), 'utf8'),
    fileCount: entry.files !== null && typeof entry.files === 'object' ? Object.keys(entry.files).length : 0,
  }
}

/** List global entries filtered by kind and a case-insensitive text query. */
export function listEntries(state, options = {}) {
  const kind = options.kind
  const needle = String(options.q ?? '').trim().toLowerCase()
  const items = []
  for (const current of KINDS) {
    if (kind && kind !== current) continue
    for (const entry of Object.values(state.entries[current] ?? {})) {
      if (entry === null || typeof entry !== 'object') continue
      if (needle) {
        const haystack = `${entry.id ?? ''}\n${entry.title ?? ''}\n${entry.content ?? ''}`.toLowerCase()
        if (!haystack.includes(needle)) continue
      }
      items.push(entryMeta(entry))
    }
  }
  return items.sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
}

/** Find one full entry; the id is looked up in parsed state, never used as a path. */
export function findEntry(state, kind, id) {
  if (!KINDS.includes(kind)) return null
  const entry = state.entries[kind]?.[id]
  return entry !== null && typeof entry === 'object' ? entry : null
}

/** Total entry count across kinds. */
export function countEntries(state) {
  let total = 0
  for (const kind of KINDS) total += Object.keys(state.entries[kind] ?? {}).length
  return total
}

/** Counts used by the overview and the header dots. */
export function entrySummary(state) {
  const byKind = {}
  let pinned = 0
  let archived = 0
  let protectedCount = 0
  for (const kind of KINDS) {
    const bucket = state.entries[kind] ?? {}
    byKind[kind] = Object.keys(bucket).length
    for (const entry of Object.values(bucket)) {
      if (entry?.metadata?.pinned) pinned += 1
      if (entry?.metadata?.lifecycleState === 'archived') archived += 1
      if (entry?.protection) protectedCount += 1
    }
  }
  return { total: countEntries(state), byKind, pinned, archived, protected: protectedCount }
}

/** Validate a session directory name before it reaches the filesystem. */
export function assertSessionKey(key) {
  if (typeof key !== 'string' || key === '.' || key === '..' || !SESSION_KEY.test(key)) {
    throw new EvolutionError('INVALID_SESSION', '会话标识不合法')
  }
  return key
}

/** List session-scoped harness stores, newest first. */
export async function listSessions(home) {
  const root = join(home, 'sessions')
  let dirents
  try { dirents = await readdir(root, { withFileTypes: true }) } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  const items = []
  for (const dirent of dirents) {
    if (!dirent.isDirectory() || !SESSION_KEY.test(dirent.name)) continue
    const key = dirent.name
    const dir = join(root, key)
    let state = emptyState()
    let stateError = null
    try { state = await readHarnessState(dir) } catch (error) { stateError = error instanceof Error ? error.message : String(error) }
    const tail = await readJsonlTail(join(dir, 'refinements.jsonl'), 1).catch(() => [])
    const summary = entrySummary(state)
    const stamps = []
    for (const bucket of Object.values(state.entries)) {
      for (const entry of Object.values(bucket ?? {})) if (entry?.updatedAt) stamps.push(entry.updatedAt)
    }
    for (const record of state.refinements) if (record?.committedAt) stamps.push(record.committedAt)
    if (tail[0]?.committedAt) stamps.push(tail[0].committedAt)
    stamps.sort()
    items.push({
      key,
      entries: summary.total,
      refinements: state.refinements.length,
      updatedAt: stamps.length ? stamps[stamps.length - 1] : null,
      error: stateError,
    })
  }
  return items
    .sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
    .slice(0, 200)
}

/** Read one session's entries and refinement history. */
export async function readSession(home, key) {
  assertSessionKey(key)
  const dir = join(home, 'sessions', key)
  const state = await readHarnessState(dir)
  const history = state.refinements.length
    ? state.refinements
    : await readJsonlTail(join(dir, 'refinements.jsonl'), 200)
  return {
    key,
    summary: entrySummary(state),
    entries: listEntries(state),
    history: stripHistory(history),
  }
}

/** Drop content snapshots so history payloads stay small. */
export function stripHistory(records) {
  return (Array.isArray(records) ? records : []).map(record => ({
    id: record?.id ?? '',
    summary: record?.summary ?? '',
    committedAt: record?.committedAt ?? null,
    scope: record?.scope ?? 'global',
    rollbackOf: record?.rollbackOf ?? null,
    edits: (Array.isArray(record?.appliedEdits) ? record.appliedEdits : []).map(edit => ({
      action: edit?.action ?? '',
      kind: edit?.kind ?? '',
      id: edit?.id ?? '',
      reason: edit?.reason ?? '',
      blastRadius: edit?.blastRadius ?? 'general',
      applied: edit?.applied !== false,
      error: edit?.error ?? null,
    })),
  }))
}

/** Read the gate-verdict audit trail. */
export async function readReviews(home, limit = 100) {
  return readJsonlTail(join(home, 'reviews.jsonl'), limit)
}

/** Read the benchmark store: cases, recent runs, and snapshot files. */
export async function readBenchmark(home, limit = 50) {
  const dir = join(home, 'benchmark')
  const result = { cases: [], casesError: null, runs: [], snapshots: [] }
  let text = null
  try { text = await readText(join(dir, 'cases.json'), CASES_MAX_BYTES) } catch (error) {
    result.casesError = error instanceof Error ? error.message : String(error)
  }
  if (text !== null) {
    try {
      const parsed = JSON.parse(text)
      result.cases = (Array.isArray(parsed?.cases) ? parsed.cases : []).map(item => ({
        id: item?.id ?? '',
        title: item?.title ?? item?.name ?? item?.id ?? '',
        state: item?.state ?? 'draft',
      }))
    } catch (error) {
      result.casesError = `cases.json 解析失败：${error.message}`
    }
  }
  const runs = await readJsonlTail(join(dir, 'runs.jsonl'), limit).catch(() => [])
  result.runs = runs.map(run => ({
    runId: run?.runId ?? '',
    status: run?.decision?.status ?? run?.status ?? 'unknown',
    refinementId: run?.decision?.refinementId ?? null,
    referenceOverall: run?.decision?.referenceOverall ?? null,
    candidateOverall: run?.decision?.candidateOverall ?? null,
    createdAt: run?.decision?.createdAt ?? run?.createdAt ?? null,
  }))
  let dirents
  try { dirents = await readdir(join(dir, 'snapshots'), { withFileTypes: true }) } catch (error) {
    if (error?.code === 'ENOENT') return result
    throw error
  }
  for (const dirent of dirents) {
    if (!dirent.isFile() || !dirent.name.endsWith('.json')) continue
    try {
      const info = await stat(join(dir, 'snapshots', dirent.name))
      result.snapshots.push({ id: dirent.name.slice(0, -5), bytes: info.size, modifiedAt: info.mtime.toISOString() })
    } catch { /* a disappearing snapshot is not an error */ }
  }
  result.snapshots.sort((a, b) => b.id.localeCompare(a.id))
  return result
}

/** Byte sizes and mtimes of the harness files the panel reports on. */
export async function fileSizes(home) {
  const files = [
    ['state', 'harness_state.json'],
    ['history', 'refinements.jsonl'],
    ['reviews', 'reviews.jsonl'],
    ['log', 'continual-harness.log'],
    ['usage', 'usage.events.jsonl'],
  ]
  const out = {}
  for (const [key, name] of files) {
    try {
      const info = await stat(join(home, name))
      out[key] = { bytes: info.size, modifiedAt: info.mtime.toISOString() }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      out[key] = null
    }
  }
  return out
}

/** Latest entry/refinement timestamp, used by the header dots. */
export function latestActivity(state, history = []) {
  const stamps = []
  for (const bucket of Object.values(state.entries)) {
    for (const entry of Object.values(bucket ?? {})) if (entry?.updatedAt) stamps.push(entry.updatedAt)
  }
  for (const record of [...state.refinements, ...history]) if (record?.committedAt) stamps.push(record.committedAt)
  stamps.sort()
  return stamps.length ? stamps[stamps.length - 1] : null
}

function effectiveConfig(entry) {
  try { return jsonClone(entry?.fiber?.config ?? entry?.options?.config ?? {}) } catch { return {} }
}

/** Find the active continual-harness profile entry, if any. */
export function findHarnessEntry(ctx) {
  return ctx.configEditor.entries().find(entry => entry.options.id === HARNESS_ENTRY_ID) ?? null
}

/** Resolve the harness data root from the live entry config or the dsh home default. */
export function resolveHarnessPaths(ctx, dshHome) {
  const entry = findHarnessEntry(ctx)
  const config = effectiveConfig(entry)
  return {
    entry,
    config,
    installed: Boolean(entry),
    active: Boolean(entry?.fiber),
    documentPath: ctx.configEditor.documentPath,
    harnessRoot: typeof config.harnessRoot === 'string' && config.harnessRoot
      ? resolve(config.harnessRoot)
      : join(dshHome, 'harness'),
    skillsDir: typeof config.skillsDir === 'string' && config.skillsDir
      ? resolve(config.skillsDir)
      : join(dshHome, 'skills'),
  }
}
