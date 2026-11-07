/**
 * Evolution record store: Evidence, Proposal, Validation and PublicationRecord.
 *
 * Four append-only tables — a row is never updated or deleted, a state change is a
 * new `version` row for the same `id`, and the current state is the highest version.
 */
import { createHash } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { chmodSync, copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

import { EvolutionError } from './harness.mjs'
import { prepareStateDir, projectHome } from '../../_shared/paths.mjs'
import { SUBJECT_SCHEMA_VERSION, envelope } from '../../_shared/contracts.mjs'
import { resolveSubject } from '../../_shared/subject.mjs'

/** Records reuse the harness error type so one catch renders every failure. */
export const EvolutionRecordError = EvolutionError

export const EVOLUTION_SCHEMA_VERSION = 1
export const MIN_SUPPORTED_SCHEMA = 1
/** `0x45564C31` — 'EVL1', written to `PRAGMA application_id` to claim ownership of the file. */
export const EVOLUTION_APPLICATION_ID = 1163283505
/** Matches the HTTP body ceiling in `http.mjs`, so a payload never fits one gate and not the other. */
export const CANONICAL_LIMIT_BYTES = 256 * 1024

/** Sources that stand on their own (docs/architecture.md:367-374). */
const DIRECT_SOURCES = ['dsh_session', 'superagent_ticket', 'superagent_receipt', 'user_feedback',
  'actmem_change', 'mempalace_conflict', 'skill_invocation']
/** Recap, dream and self-review are derived material, never primary evidence (docs/architecture.md:378). */
export const DERIVED_ONLY_SOURCES = ['recap', 'dream', 'model_self_review']
export const EVIDENCE_SOURCES = [...DIRECT_SOURCES, ...DERIVED_ONLY_SOURCES]

export const CANDIDATE_KINDS = ['persona', 'active_memory', 'long_term_knowledge', 'skill', 'behaviour_prompt', 'subagent']
/** Which domain owns each candidate kind (docs/architecture.md:382-389). */
export const CANDIDATE_OWNERS = Object.freeze({
  persona: 'laputa',
  active_memory: 'actmem',
  long_term_knowledge: 'mempalace',
  skill: 'skill_owner',
  behaviour_prompt: 'prompt_owner',
  subagent: 'agent_registry',
})

export const PROPOSAL_STATES = ['proposed', 'validating', 'validated', 'rejected', 'published', 'superseded', 'rolled_back']
export const PUBLICATION_STATES = ['live', 'superseded', 'rolled_back']
export const VALIDATION_VERDICTS = ['passed', 'failed', 'blocked']
export const PUBLICATION_PURPOSES = ['publish', 'rollback']

export const PROPOSAL_TRANSITIONS = Object.freeze({
  proposed: ['validating', 'validated', 'rejected'],
  validating: ['validated', 'rejected', 'proposed'],
  validated: ['published', 'rejected', 'superseded'],
  rejected: ['proposed'],
  published: ['superseded', 'rolled_back'],
  superseded: [],
  rolled_back: ['published'],
})

export const PUBLICATION_TRANSITIONS = Object.freeze({
  live: ['superseded', 'rolled_back'],
  superseded: [],
  rolled_back: ['live'],
})

/**
 * Owner capabilities. `versionedWrite` gates publication: until an owner can write a
 * versioned, revertible change, a candidate stays a Proposal (docs/architecture.md:391).
 */
export const OWNERS = Object.freeze({
  laputa: {
    versionedWrite: true,
    minChecks: ['baseline', 'diff', 'provenance', 'semantic', 'rollback'],
    ownerRefFields: ['personaId', 'revision', 'contentDigest'],
  },
  actmem: {
    versionedWrite: true,
    minChecks: ['dedupe', 'relation', 'privacy', 'recall'],
    ownerRefFields: ['memoryId', 'revision'],
  },
  mempalace: {
    versionedWrite: true,
    minChecks: ['provenance', 'conflict', 'integrity', 'retrieval'],
    ownerRefFields: ['knowledgeId', 'revision', 'digest'],
  },
  skill_owner: {
    versionedWrite: false,
    minChecks: ['frozenSource', 'baseline', 'holdout'],
    ownerRefFields: ['skillId', 'publicationId'],
  },
  prompt_owner: {
    versionedWrite: false,
    minChecks: ['scope', 'regression', 'versionPin'],
    ownerRefFields: ['presetId', 'revision'],
  },
  agent_registry: {
    versionedWrite: false,
    minChecks: ['identity', 'toolScope', 'regression'],
    ownerRefFields: ['agentId', 'revision'],
  },
})

/** Every machine code this module can surface; `SUBJECT_UNAVAILABLE` is reused from `_shared`. */
export const EVOLUTION_CODES = Object.freeze([
  'EVOLUTION_SQLITE_UNAVAILABLE',
  'EVOLUTION_STORE_UNAVAILABLE',
  'EVOLUTION_STORE_FOREIGN',
  'EVOLUTION_SCHEMA_UNSUPPORTED',
  'EVOLUTION_APPEND_ONLY',
  'EVOLUTION_CONFLICT',
  'EVOLUTION_VALIDATION_CONSUMED',
  'EVOLUTION_EVIDENCE_CONFLICT',
  'EVOLUTION_SUBJECT_MISMATCH',
  'EVOLUTION_INVALID_RECORD',
  'EVOLUTION_TICKET_REQUIRED',
  'EVOLUTION_NOT_FOUND',
  'EVOLUTION_STALE_VALIDATION',
  'EVOLUTION_VALIDATION_REQUIRED',
  'EVOLUTION_VALIDATION_INSUFFICIENT',
  'EVOLUTION_OWNER_UNSUPPORTED',
  'EVOLUTION_OWNER_REF_REQUIRED',
  'EVOLUTION_OWNER_API_REQUIRED',
  'EVOLUTION_OWNER_FAILED',
  'EVOLUTION_ROLLBACK_TARGET_INVALID',
  'EVOLUTION_SOURCE_NOT_ALLOWED',
  'EVOLUTION_DERIVED_INSUFFICIENT',
  'EVOLUTION_LIMIT_EXCEEDED',
  'EVOLUTION_STATE_CORRUPT',
  'EVOLUTION_ALREADY_LIVE',
  'EVOLUTION_UNKNOWN_EVIDENCE',
  'EVOLUTION_UNKNOWN_PROPOSAL',
  'EVOLUTION_TICKET_MISMATCH',
  'SUBJECT_UNAVAILABLE',
])

const OPERATOR_HINT = '进化记录存储不可用：请升级到 Node 22.19+ 或 24+（`node:sqlite` 从 22.13 起免实验开关），'
  + '或在低版本上以 `node --experimental-sqlite` 启动宿主；Evolution 的其他视图不受影响。'

function fail(code, message, hint) {
  throw new EvolutionRecordError(code, message, hint)
}

/** JSON with object keys sorted recursively, so an identical value always digests identically. */
export function canonicalJson(value, { maxBytes = CANONICAL_LIMIT_BYTES } = {}) {
  const out = render(value, 0)
  const bytes = Buffer.byteLength(out, 'utf8')
  if (bytes > maxBytes) {
    fail('EVOLUTION_LIMIT_EXCEEDED',
      `规范化记录 ${bytes} 字节，超过上限 ${maxBytes}`,
      `请缩小 summary、refs 或 checks（当前上限 ${maxBytes} 字节，可用 limits.canonicalBytes 调整）`)
  }
  return out
}

function render(value, depth) {
  if (value === null || value === undefined) return 'null'
  const type = typeof value
  if (type === 'number') {
    if (!Number.isFinite(value)) fail('EVOLUTION_INVALID_RECORD', `记录含非有限数字 ${value}`, '请写入可序列化的数字')
    return JSON.stringify(value)
  }
  if (type === 'string' || type === 'boolean') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(item => render(item, depth + 1)).join(',')}]`
  if (type === 'object') {
    const proto = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) {
      fail('EVOLUTION_INVALID_RECORD', `记录含 ${(value.constructor?.name ?? '非普通')} 对象`,
        '只允许 JSON 值：Set、Map 与类实例请先转成数组或普通对象')
    }
    const parts = []
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) continue
      parts.push(`${JSON.stringify(key)}:${render(value[key], depth + 1)}`)
    }
    return `{${parts.join(',')}}`
  }
  fail('EVOLUTION_INVALID_RECORD', `记录含无法序列化的 ${type}`, '只允许 JSON 值：对象、数组、字符串、数字、布尔与 null')
}

/** sha256 of the canonical form — the CAS anchor for every record. */
export function digestOf(value, options) {
  return createHash('sha256').update(canonicalJson(value, options), 'utf8').digest('hex')
}

/** Content-addressed id. Never time-based, so a replay derives the same id. */
export function deriveRecordId(prefix, identity, options) {
  if (typeof prefix !== 'string' || !/^[a-z][a-z]{1,15}$/.test(prefix)) {
    fail('EVOLUTION_INVALID_RECORD', `非法的记录 id 前缀 ${JSON.stringify(prefix)}`, '前缀只允许 2–16 个小写字母')
  }
  return `${prefix}_${digestOf(identity, options).slice(0, 32)}`
}

/** @returns {{source: string, derived: boolean}} */
export function assertEvidenceSource(source, { derivedFrom } = {}) {
  if (typeof source !== 'string' || !EVIDENCE_SOURCES.includes(source)) {
    fail('EVOLUTION_SOURCE_NOT_ALLOWED', `未知的证据来源 ${JSON.stringify(source)}`,
      `允许的取值：${EVIDENCE_SOURCES.join('、')}`)
  }
  const derived = DERIVED_ONLY_SOURCES.includes(source)
  if (derived && (!Array.isArray(derivedFrom) || derivedFrom.length === 0)) {
    fail('EVOLUTION_DERIVED_INSUFFICIENT', `${source} 属于派生材料，必须给出 derivedFrom`,
      'Recap、Dream 与模型自评只能引用原始证据 id；没有出处时请改用 dsh_session 或 user_feedback')
  }
  return { source, derived }
}

/** @returns {string} the owner kind this candidate belongs to */
export function assertCandidateOwnerPair({ candidateKind, ownerKind } = {}) {
  const expected = CANDIDATE_OWNERS[candidateKind]
  if (!expected) {
    fail('EVOLUTION_INVALID_RECORD', `未知的候选类型 ${JSON.stringify(candidateKind)}`,
      `允许的取值：${CANDIDATE_KINDS.join('、')}`)
  }
  if (ownerKind !== expected) {
    fail('EVOLUTION_INVALID_RECORD',
      `候选 ${candidateKind} 的所有者是 ${expected}，不是 ${JSON.stringify(ownerKind)}`,
      '每条候选只归属一个域；请让对应所有者接收这条 Proposal')
  }
  return ownerKind
}

export function ownerAllowsPublish(ownerKind) {
  return OWNERS[ownerKind]?.versionedWrite === true
}

/** Normalized check kinds, or the failure naming which owner checks are still missing. */
export function assertChecksCovered(ownerKind, checks) {
  const spec = OWNERS[ownerKind]
  if (!spec) {
    fail('EVOLUTION_INVALID_RECORD', `未知的所有者 ${JSON.stringify(ownerKind)}`,
      `允许的所有者：${Object.keys(OWNERS).join('、')}`)
  }
  if (!Array.isArray(checks)) {
    fail('EVOLUTION_INVALID_RECORD', `${ownerKind} 的 checks 必须是数组`, '请提交 [{kind, ...}] 或 ["kind", ...]')
  }
  const kinds = new Set()
  for (const entry of checks) {
    const kind = typeof entry === 'string' ? entry : entry?.kind
    if (typeof kind !== 'string' || !kind.trim()) {
      fail('EVOLUTION_INVALID_RECORD', `${ownerKind} 的 checks 含无 kind 的条目`, '每项验证都要带非空 kind')
    }
    kinds.add(kind.trim())
  }
  const missing = spec.minChecks.filter(kind => !kinds.has(kind))
  if (missing.length > 0) {
    fail('EVOLUTION_VALIDATION_INSUFFICIENT', `${ownerKind} 的验证缺少必需项：${missing.join('、')}`,
      `该所有者要求覆盖 ${spec.minChecks.join('、')}；缺项时候选不得进入发布队列`)
  }
  return [...kinds].sort()
}

/** @returns {string} the requested target state */
export function assertAllowedTransition(kind, from, to) {
  const table = kind === 'proposal' ? PROPOSAL_TRANSITIONS : kind === 'publication' ? PUBLICATION_TRANSITIONS : null
  if (!table) {
    fail('EVOLUTION_INVALID_RECORD', `未知的状态机 ${JSON.stringify(kind)}`, '状态机只有 proposal 与 publication')
  }
  if (!Object.hasOwn(table, from)) {
    fail('EVOLUTION_INVALID_RECORD', `${kind} 当前状态 ${JSON.stringify(from)} 不在枚举内`,
      `允许的状态：${Object.keys(table).join('、')}`)
  }
  if (!table[from].includes(to)) {
    const allowed = table[from].length > 0 ? table[from].join('、') : '（终态，不可再转移）'
    fail('EVOLUTION_CONFLICT', `${kind} 不能从 ${from} 转移到 ${to}`, `状态 ${from} 允许的下一步：${allowed}`)
  }
  return to
}

/** `node:sqlite` is loaded on first use so a runtime without it never breaks the host. */
export async function loadSqliteModule({ importModule = () => import('node:sqlite') } = {}) {
  let sqlite
  try {
    sqlite = await importModule()
  } catch (error) {
    fail('EVOLUTION_SQLITE_UNAVAILABLE', `当前运行时无法加载 node:sqlite：${error?.message ?? error}`, OPERATOR_HINT)
  }
  if (!sqlite || typeof sqlite.DatabaseSync !== 'function') {
    fail('EVOLUTION_SQLITE_UNAVAILABLE', '当前运行时的 node:sqlite 缺少 DatabaseSync', OPERATOR_HINT)
  }
  return sqlite
}

/* -------------------------------------- storage layout -------------------------------------- */

/** The tables this store owns; any other user table in the file means it is not ours. */
const OUR_TABLES = ['meta', 'evidence', 'proposal', 'validation', 'publication']

/**
 * v1 schema. Append-only is a database property, not a coding convention: every history
 * table refuses UPDATE and DELETE, and the domain guards below make a fake "live"
 * publication unrepresentable even by a direct SQL writer.
 */
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS evidence (
  id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version = 1),
  subject_id TEXT NOT NULL CHECK (subject_id GLOB 'subject_*' AND length(subject_id) = 44),
  ticket_id TEXT CHECK (ticket_id IS NULL OR length(ticket_id) BETWEEN 1 AND 128),
  source TEXT NOT NULL CHECK (source IN ('dsh_session', 'superagent_ticket', 'superagent_receipt',
    'user_feedback', 'actmem_change', 'mempalace_conflict', 'skill_invocation',
    'recap', 'dream', 'model_self_review')),
  summary TEXT NOT NULL CHECK (length(summary) BETWEEN 1 AND 4000),
  refs TEXT NOT NULL CHECK (json_valid(refs) AND COALESCE(json_type(refs), '') = 'object'),
  derived_from TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(derived_from) AND COALESCE(json_type(derived_from), '') = 'array'),
  external_id TEXT,
  dedupe_key TEXT NOT NULL CHECK (length(dedupe_key) BETWEEN 1 AND 128),
  digest TEXT NOT NULL CHECK (digest GLOB '[0-9a-f]*' AND length(digest) = 64),
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  provenance TEXT NOT NULL CHECK (json_valid(provenance) AND COALESCE(json_type(provenance), '') = 'object'),
  created_at TEXT NOT NULL,
  PRIMARY KEY (id, version),
  UNIQUE (subject_id, source, dedupe_key)
);

CREATE TABLE IF NOT EXISTS proposal (
  id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  subject_id TEXT NOT NULL CHECK (subject_id GLOB 'subject_*' AND length(subject_id) = 44),
  ticket_id TEXT NOT NULL CHECK (length(ticket_id) BETWEEN 1 AND 128),
  candidate_kind TEXT NOT NULL,
  owner_kind TEXT NOT NULL,
  asset_scope TEXT NOT NULL CHECK (length(asset_scope) BETWEEN 1 AND 200),
  candidate_digest TEXT NOT NULL CHECK (candidate_digest GLOB '[0-9a-f]*' AND length(candidate_digest) = 64),
  summary TEXT NOT NULL CHECK (length(summary) BETWEEN 1 AND 4000),
  candidate_ref TEXT,
  evidence_ids TEXT NOT NULL CHECK (json_valid(evidence_ids) AND COALESCE(json_type(evidence_ids), '') = 'array'),
  state TEXT NOT NULL CHECK (state IN ('proposed', 'validating', 'validated', 'rejected',
    'published', 'superseded', 'rolled_back')),
  reason TEXT,
  digest TEXT NOT NULL CHECK (digest GLOB '[0-9a-f]*' AND length(digest) = 64),
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  provenance TEXT NOT NULL CHECK (json_valid(provenance) AND COALESCE(json_type(provenance), '') = 'object'),
  created_at TEXT NOT NULL,
  PRIMARY KEY (id, version),
  CHECK ((candidate_kind = 'persona' AND owner_kind = 'laputa')
    OR (candidate_kind = 'active_memory' AND owner_kind = 'actmem')
    OR (candidate_kind = 'long_term_knowledge' AND owner_kind = 'mempalace')
    OR (candidate_kind = 'skill' AND owner_kind = 'skill_owner')
    OR (candidate_kind = 'behaviour_prompt' AND owner_kind = 'prompt_owner')
    OR (candidate_kind = 'subagent' AND owner_kind = 'agent_registry'))
);

CREATE TABLE IF NOT EXISTS validation (
  id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version = 1),
  subject_id TEXT NOT NULL CHECK (subject_id GLOB 'subject_*' AND length(subject_id) = 44),
  ticket_id TEXT NOT NULL CHECK (length(ticket_id) BETWEEN 1 AND 128),
  proposal_id TEXT NOT NULL,
  proposal_digest TEXT NOT NULL CHECK (proposal_digest GLOB '[0-9a-f]*' AND length(proposal_digest) = 64),
  candidate_digest TEXT NOT NULL CHECK (candidate_digest GLOB '[0-9a-f]*' AND length(candidate_digest) = 64),
  verdict TEXT NOT NULL CHECK (verdict IN ('passed', 'failed', 'blocked')),
  checks TEXT NOT NULL CHECK (json_valid(checks) AND COALESCE(json_type(checks), '') = 'array'),
  runner TEXT,
  approval_ref TEXT,
  notes TEXT,
  digest TEXT NOT NULL CHECK (digest GLOB '[0-9a-f]*' AND length(digest) = 64),
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  provenance TEXT NOT NULL CHECK (json_valid(provenance) AND COALESCE(json_type(provenance), '') = 'object'),
  created_at TEXT NOT NULL,
  PRIMARY KEY (id, version)
);

CREATE TABLE IF NOT EXISTS publication (
  id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  subject_id TEXT NOT NULL CHECK (subject_id GLOB 'subject_*' AND length(subject_id) = 44),
  ticket_id TEXT NOT NULL CHECK (length(ticket_id) BETWEEN 1 AND 128),
  proposal_id TEXT NOT NULL,
  proposal_digest TEXT NOT NULL CHECK (proposal_digest GLOB '[0-9a-f]*' AND length(proposal_digest) = 64),
  candidate_digest TEXT NOT NULL CHECK (candidate_digest GLOB '[0-9a-f]*' AND length(candidate_digest) = 64),
  validation_id TEXT,
  purpose TEXT NOT NULL CHECK (purpose IN ('publish', 'rollback')),
  owner_kind TEXT NOT NULL,
  asset_scope TEXT NOT NULL CHECK (length(asset_scope) BETWEEN 1 AND 200),
  owner_ref TEXT,
  supersedes_publication_id TEXT,
  restored_from_publication_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('live', 'superseded', 'rolled_back')),
  error TEXT,
  approval_refs TEXT NOT NULL DEFAULT '[]',
  actor_ref TEXT,
  published_at TEXT,
  digest TEXT NOT NULL CHECK (digest GLOB '[0-9a-f]*' AND length(digest) = 64),
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  provenance TEXT NOT NULL CHECK (json_valid(provenance) AND COALESCE(json_type(provenance), '') = 'object'),
  created_at TEXT NOT NULL,
  PRIMARY KEY (id, version)
);

CREATE TRIGGER IF NOT EXISTS evidence_no_update BEFORE UPDATE ON evidence
  BEGIN SELECT RAISE(ABORT, 'evolution_history_append_only'); END;
CREATE TRIGGER IF NOT EXISTS evidence_no_delete BEFORE DELETE ON evidence
  BEGIN SELECT RAISE(ABORT, 'evolution_history_append_only'); END;
CREATE TRIGGER IF NOT EXISTS proposal_no_update BEFORE UPDATE ON proposal
  BEGIN SELECT RAISE(ABORT, 'evolution_history_append_only'); END;
CREATE TRIGGER IF NOT EXISTS proposal_no_delete BEFORE DELETE ON proposal
  BEGIN SELECT RAISE(ABORT, 'evolution_history_append_only'); END;
CREATE TRIGGER IF NOT EXISTS validation_no_update BEFORE UPDATE ON validation
  BEGIN SELECT RAISE(ABORT, 'evolution_history_append_only'); END;
CREATE TRIGGER IF NOT EXISTS validation_no_delete BEFORE DELETE ON validation
  BEGIN SELECT RAISE(ABORT, 'evolution_history_append_only'); END;
CREATE TRIGGER IF NOT EXISTS publication_no_update BEFORE UPDATE ON publication
  BEGIN SELECT RAISE(ABORT, 'evolution_history_append_only'); END;
CREATE TRIGGER IF NOT EXISTS publication_no_delete BEFORE DELETE ON publication
  BEGIN SELECT RAISE(ABORT, 'evolution_history_append_only'); END;

CREATE TRIGGER IF NOT EXISTS evidence_derived_needs_source BEFORE INSERT ON evidence
  BEGIN SELECT RAISE(ABORT, 'evolution_derived_insufficient')
    WHERE NEW.source IN ('recap', 'dream', 'model_self_review')
      AND COALESCE(json_array_length(NEW.derived_from), 0) = 0; END;

CREATE TRIGGER IF NOT EXISTS proposal_evidence_exists BEFORE INSERT ON proposal
  BEGIN SELECT RAISE(ABORT, 'evolution_unknown_evidence')
    WHERE EXISTS (SELECT 1 FROM json_each(NEW.evidence_ids) j WHERE NOT EXISTS (
      SELECT 1 FROM evidence e WHERE e.id = j.value AND e.subject_id = NEW.subject_id)); END;

CREATE TRIGGER IF NOT EXISTS proposal_needs_direct_evidence BEFORE INSERT ON proposal
  BEGIN SELECT RAISE(ABORT, 'evolution_derived_insufficient')
    WHERE NOT EXISTS (SELECT 1 FROM json_each(NEW.evidence_ids) j JOIN evidence e ON e.id = j.value
      WHERE e.source NOT IN ('recap', 'dream', 'model_self_review')); END;

CREATE TRIGGER IF NOT EXISTS proposal_ticket_vs_evidence BEFORE INSERT ON proposal
  BEGIN SELECT RAISE(ABORT, 'evolution_ticket_mismatch')
    WHERE EXISTS (SELECT 1 FROM json_each(NEW.evidence_ids) j JOIN evidence e ON e.id = j.value
      WHERE e.ticket_id IS NOT NULL AND e.ticket_id IS NOT NEW.ticket_id); END;

CREATE TRIGGER IF NOT EXISTS validation_binds_proposal BEFORE INSERT ON validation
  BEGIN SELECT RAISE(ABORT, 'evolution_unknown_proposal')
    WHERE NOT EXISTS (SELECT 1 FROM proposal p WHERE p.id = NEW.proposal_id AND p.subject_id = NEW.subject_id
      AND p.version = (SELECT max(q.version) FROM proposal q WHERE q.id = NEW.proposal_id)
      AND p.digest = NEW.proposal_digest AND p.ticket_id IS NEW.ticket_id); END;

CREATE TRIGGER IF NOT EXISTS publication_requires_passed_validation BEFORE INSERT ON publication
  FOR EACH ROW WHEN NEW.purpose = 'publish'
  BEGIN SELECT RAISE(ABORT, 'evolution_publish_requires_validation')
    WHERE NOT EXISTS (SELECT 1 FROM validation v WHERE v.id = NEW.validation_id AND v.subject_id = NEW.subject_id
      AND v.verdict = 'passed' AND v.proposal_digest = NEW.proposal_digest
      AND v.candidate_digest = NEW.candidate_digest); END;

CREATE TRIGGER IF NOT EXISTS publication_restores_target BEFORE INSERT ON publication
  FOR EACH ROW WHEN NEW.purpose = 'rollback'
  BEGIN SELECT RAISE(ABORT, 'evolution_rollback_target_invalid')
    WHERE NOT EXISTS (SELECT 1 FROM publication t WHERE t.id = NEW.restored_from_publication_id
      AND t.subject_id = NEW.subject_id AND t.asset_scope = NEW.asset_scope AND t.purpose = 'publish'
      AND COALESCE(json_type(t.owner_ref), '') = 'object' AND t.digest IS NOT NEW.digest); END;

CREATE TRIGGER IF NOT EXISTS publication_live_needs_owner_ref BEFORE INSERT ON publication
  FOR EACH ROW WHEN NEW.state = 'live'
  BEGIN SELECT RAISE(ABORT, 'evolution_owner_ref_required')
    WHERE COALESCE(json_type(NEW.owner_ref), '') <> 'object'; END;

CREATE TRIGGER IF NOT EXISTS publication_single_live BEFORE INSERT ON publication
  FOR EACH ROW WHEN NEW.state = 'live'
  BEGIN SELECT RAISE(ABORT, 'evolution_already_live')
    WHERE EXISTS (SELECT 1 FROM publication p WHERE p.asset_scope = NEW.asset_scope AND p.state = 'live'
      AND p.id IS NOT NEW.id
      AND p.version = (SELECT max(q.version) FROM publication q WHERE q.id = p.id)); END;

CREATE UNIQUE INDEX IF NOT EXISTS publication_validation_once ON publication(validation_id)
  WHERE validation_id IS NOT NULL AND version = 1;

CREATE INDEX IF NOT EXISTS evidence_ticket ON evidence(ticket_id) WHERE ticket_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS evidence_subject ON evidence(subject_id, source);
CREATE INDEX IF NOT EXISTS proposal_subject_state ON proposal(subject_id, state);
CREATE INDEX IF NOT EXISTS proposal_ticket ON proposal(ticket_id);
CREATE INDEX IF NOT EXISTS proposal_head ON proposal(id, version DESC);
CREATE INDEX IF NOT EXISTS validation_proposal ON validation(proposal_id);
CREATE INDEX IF NOT EXISTS validation_ticket ON validation(ticket_id);
CREATE INDEX IF NOT EXISTS publication_head ON publication(id, version DESC);
CREATE INDEX IF NOT EXISTS publication_asset_state ON publication(asset_scope, state);
CREATE INDEX IF NOT EXISTS publication_proposal ON publication(proposal_id);
CREATE INDEX IF NOT EXISTS publication_subject_state ON publication(subject_id, state);
CREATE INDEX IF NOT EXISTS publication_ticket ON publication(ticket_id);
`

/** Where the store keeps its file; explicit overrides must stay absolute and inside the contract. */
export function resolveEvolutionPaths(env = process.env, dshHome, { stateDir, dbPath } = {}) {
  let dir
  let file
  try {
    const explicit = stateDir ?? env.DSH_EVOLUTION_STATE_DIR
    let fallback
    if (explicit !== undefined && explicit !== null && explicit !== '') {
      fallback = String(explicit)
    } else {
      const home = typeof dshHome === 'string' && dshHome ? dshHome : projectHome(env)
      fallback = join(home, 'evolution')
    }
    if (!isAbsolute(fallback)) {
      throw new Error(`必须是绝对路径（当前 ${JSON.stringify(fallback)}）`)
    }
    dir = resolve(fallback)
    file = dbPath && isAbsolute(dbPath) ? resolve(dbPath) : join(dir, 'evolution.db')
  } catch (error) {
    fail('EVOLUTION_INVALID_RECORD', `无法解析 Evolution 记录存储路径：${error.message}`,
      '请用项目启动器运行（DSH_HOME 必须是绝对路径），或把 DSH_EVOLUTION_STATE_DIR 设为绝对路径')
  }
  return { dir, file }
}

function readPragma(db, name) {
  const row = db.prepare(`PRAGMA ${name}`).get()
  return row?.[name] ?? row?.timeout
}

/* -------------------------------- field guards (mirror the table CHECKs) -------------------------------- */

const EVIDENCE_COLUMNS = 'id, version, subject_id, ticket_id, source, summary, refs, derived_from, external_id, dedupe_key, digest, schema_version, provenance, created_at'
const MAX_SUMMARY_LENGTH = 4000
const MAX_TICKET_LENGTH = 128
const MAX_DEDUPE_LENGTH = 128
const MAX_ID_LENGTH = 128
const MAX_ASSET_SCOPE_LENGTH = 200
const DIGEST = /^[0-9a-f]{64}$/

/** A friendly 400 beats a raw `CHECK constraint failed`, so the limits live in both places. */
function assertShortText(value, field, max, { optional = false } = {}) {
  if (value === undefined || value === null) {
    if (optional) return null
    fail('EVOLUTION_INVALID_RECORD', `${field} 是必填的`, `请提供 ${field}（1–${max} 个字符）`)
  }
  if (typeof value !== 'string' || !value.trim()) {
    fail('EVOLUTION_INVALID_RECORD', `${field} 必须是非空字符串`, `请填写 ${field}（1–${max} 个字符）`)
  }
  const trimmed = value.trim()
  if (trimmed.length > max) {
    fail('EVOLUTION_INVALID_RECORD', `${field} 长 ${trimmed.length} 字符，超过 ${max}`, `请缩短 ${field}`)
  }
  return trimmed
}

function assertSummary(value) {
  return assertShortText(value, 'summary', MAX_SUMMARY_LENGTH)
}

function assertTicket(value, { optional = false } = {}) {
  return assertShortText(value, 'ticketId', MAX_TICKET_LENGTH, { optional })
}

/** Evidence has to point at something real, so an empty locator bag is refused. */
function assertLocator(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    fail('EVOLUTION_INVALID_RECORD', 'refs 必须是一个定位符对象',
      '例如 {sessionKey, turn}、{archiveId}、{path} 或 {ticketId}')
  }
  const refs = {}
  for (const [key, item] of Object.entries(value)) if (item !== undefined) refs[key] = item
  if (Object.keys(refs).length === 0) {
    fail('EVOLUTION_INVALID_RECORD', 'refs 至少要给出一个定位符', '没有任何字段的 refs 无法回溯到原始出处')
  }
  return refs
}

function assertIdList(value, field) {
  if (!Array.isArray(value)) fail('EVOLUTION_INVALID_RECORD', `${field} 必须是 id 数组`, `请传入字符串数组`)
  const seen = new Set()
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim() || item.length > MAX_ID_LENGTH) {
      fail('EVOLUTION_INVALID_RECORD', `${field} 含非法 id ${JSON.stringify(item)}`, `每个 id 需为 1–${MAX_ID_LENGTH} 个字符的字符串`)
    }
    seen.add(item.trim())
  }
  return [...seen]
}

function assertDigest(value, field) {
  if (typeof value !== 'string' || !DIGEST.test(value)) {
    fail('EVOLUTION_INVALID_RECORD', `${field} 必须是 64 位小写十六进制摘要`, '请用 digestOf(候选内容) 重新计算后再提交')
  }
  return value
}

/** Proposal and Publication must hang on a ticket; Evidence may exist before one (index.md:427). */
function assertRequiredTicket(value) {
  if (value === undefined || value === null || !String(value).trim()) {
    fail('EVOLUTION_TICKET_REQUIRED', 'Proposal 与 Publication 必须带 ticketId',
      '先把这条进化诉求登记为 Superagent Ticket，再把它的 id 带进来；Evolution 只存 id，不复制任务生命周期')
  }
  return assertShortText(value, 'ticketId', MAX_TICKET_LENGTH)
}

/**
 * An owner reference names the version the owner produced; it never carries the asset itself.
 * A missing reference cannot be published (docs/architecture.md invariant #15), an oversized one is refused.
 */
export function assertOwnerRef(ownerKind, value) {
  const spec = OWNERS[ownerKind]
  if (!spec) {
    fail('EVOLUTION_INVALID_RECORD', `未知的所有者 ${JSON.stringify(ownerKind)}`,
      `允许的所有者：${Object.keys(OWNERS).join('、')}`)
  }
  const declared = spec.ownerRefFields
  if (value === undefined || value === null || typeof value !== 'object' || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    fail('EVOLUTION_OWNER_REF_REQUIRED', `${ownerKind} 的 owner_ref 必须是引用对象，收到 ${JSON.stringify(value)}`,
      `请传 {${declared.join(', ')}}` + '；live 发布必须带回所有者写入后的版本引用，拿不到引用就还没有真正发布')
  }
  const missing = declared.filter(field => {
    const item = value[field]
    return item === undefined || item === null || String(item).trim() === ''
  })
  if (missing.length > 0) {
    fail('EVOLUTION_OWNER_REF_REQUIRED', `${ownerKind} 的 owner_ref 缺少字段：${missing.join('、')}`,
      `该所有者声明的引用字段是 ${declared.join('、')}；缺任一项都无法回溯到具体版本`)
  }
  const extra = Object.keys(value).filter(field => !declared.includes(field))
  if (extra.length > 0) {
    fail('EVOLUTION_INVALID_RECORD', `${ownerKind} 的 owner_ref 含未声明的字段：${extra.join('、')}`,
      `owner_ref 只登记引用（${declared.join('、')}），正文与字节留在所有者那边`)
  }
  const result = {}
  for (const field of declared) {
    const item = value[field]
    if (typeof item === 'string') result[field] = assertShortText(item, `ownerRef.${field}`, MAX_ASSET_SCOPE_LENGTH)
    else if (typeof item === 'number' || typeof item === 'boolean') result[field] = item
    else fail('EVOLUTION_INVALID_RECORD', `ownerRef.${field} 必须是字符串或数字`, '引用字段不接受嵌套对象或数组')
  }
  return result
}

const PUBLICATION_COLUMNS = 'id, version, subject_id, ticket_id, proposal_id, proposal_digest, candidate_digest, validation_id, purpose, owner_kind, asset_scope, owner_ref, supersedes_publication_id, restored_from_publication_id, state, error, approval_refs, actor_ref, published_at, digest, schema_version, provenance, created_at'

function publicationView(row) {
  return {
    id: row.id,
    version: Number(row.version),
    subjectId: row.subject_id,
    ticketId: row.ticket_id,
    proposalId: row.proposal_id,
    proposalDigest: row.proposal_digest,
    candidateDigest: row.candidate_digest,
    validationId: row.validation_id ?? null,
    purpose: row.purpose,
    ownerKind: row.owner_kind,
    assetScope: row.asset_scope,
    ownerRef: row.owner_ref === null || row.owner_ref === undefined ? null : JSON.parse(row.owner_ref),
    supersedesPublicationId: row.supersedes_publication_id ?? null,
    restoredFromPublicationId: row.restored_from_publication_id ?? null,
    state: row.state,
    error: row.error ?? null,
    approvalRefs: JSON.parse(row.approval_refs),
    actorRef: row.actor_ref ?? null,
    publishedAt: row.published_at ?? null,
    digest: row.digest,
    schemaVersion: Number(row.schema_version),
    provenance: JSON.parse(row.provenance),
    createdAt: row.created_at,
  }
}

/**
 * The canonical body behind each record's content address. verifyHistory() rebuilds it from
 * the stored columns, so a rewritten row shows up as a digest mismatch.
 */
const RECORD_BODIES = {
  evidence: row => ({
    subjectId: row.subject_id,
    ticketId: row.ticket_id ?? null,
    source: row.source,
    summary: row.summary,
    refs: JSON.parse(row.refs),
    derivedFrom: JSON.parse(row.derived_from),
    externalId: row.external_id ?? null,
    dedupeKey: row.dedupe_key,
  }),
  proposal: row => ({
    subjectId: row.subject_id,
    ticketId: row.ticket_id,
    candidateKind: row.candidate_kind,
    ownerKind: row.owner_kind,
    assetScope: row.asset_scope,
    candidateDigest: row.candidate_digest,
    summary: row.summary,
    candidateRef: row.candidate_ref ?? null,
    evidenceIds: JSON.parse(row.evidence_ids),
    state: row.state,
    reason: row.reason ?? null,
  }),
  validation: row => ({
    subjectId: row.subject_id,
    ticketId: row.ticket_id,
    proposalId: row.proposal_id,
    proposalDigest: row.proposal_digest,
    candidateDigest: row.candidate_digest,
    checks: JSON.parse(row.checks),
    verdict: row.verdict,
  }),
  publication: row => ({
    subjectId: row.subject_id,
    ticketId: row.ticket_id,
    proposalId: row.proposal_id,
    proposalDigest: row.proposal_digest,
    candidateDigest: row.candidate_digest,
    validationId: row.validation_id ?? null,
    purpose: row.purpose,
    ownerKind: row.owner_kind,
    assetScope: row.asset_scope,
    ownerRef: row.owner_ref === null || row.owner_ref === undefined ? null : JSON.parse(row.owner_ref),
    supersedesPublicationId: row.supersedes_publication_id ?? null,
    restoredFromPublicationId: row.restored_from_publication_id ?? null,
    state: row.state,
    error: row.error ?? null,
  }),
}

/** One recompute path for both the write and the audit, so they cannot drift apart. */
function digestOfStoredRow(table, row, limits) {
  const provenance = JSON.parse(row.provenance)
  delete provenance.at
  return digestOf({ ...RECORD_BODIES[table](row), schemaVersion: Number(row.schema_version), provenance }, limits)
}

function evidenceView(row) {
  return {
    id: row.id,
    version: Number(row.version),
    subjectId: row.subject_id,
    ticketId: row.ticket_id ?? null,
    source: row.source,
    summary: row.summary,
    refs: JSON.parse(row.refs),
    derivedFrom: JSON.parse(row.derived_from),
    externalId: row.external_id ?? null,
    dedupeKey: row.dedupe_key,
    digest: row.digest,
    schemaVersion: Number(row.schema_version),
    provenance: JSON.parse(row.provenance),
    createdAt: row.created_at,
  }
}

const PROPOSAL_COLUMNS = 'id, version, subject_id, ticket_id, candidate_kind, owner_kind, asset_scope, candidate_digest, summary, candidate_ref, evidence_ids, state, reason, digest, schema_version, provenance, created_at'
const VALIDATION_COLUMNS = 'id, version, subject_id, ticket_id, proposal_id, proposal_digest, candidate_digest, verdict, checks, runner, approval_ref, notes, digest, schema_version, provenance, created_at'

function proposalView(row) {
  return {
    id: row.id,
    version: Number(row.version),
    subjectId: row.subject_id,
    ticketId: row.ticket_id,
    candidateKind: row.candidate_kind,
    ownerKind: row.owner_kind,
    assetScope: row.asset_scope,
    candidateDigest: row.candidate_digest,
    summary: row.summary,
    candidateRef: row.candidate_ref ?? null,
    evidenceIds: JSON.parse(row.evidence_ids),
    state: row.state,
    reason: row.reason ?? null,
    digest: row.digest,
    schemaVersion: Number(row.schema_version),
    provenance: JSON.parse(row.provenance),
    createdAt: row.created_at,
  }
}

function validationView(row) {
  return {
    id: row.id,
    version: Number(row.version),
    subjectId: row.subject_id,
    ticketId: row.ticket_id,
    proposalId: row.proposal_id,
    proposalDigest: row.proposal_digest,
    candidateDigest: row.candidate_digest,
    verdict: row.verdict,
    checks: JSON.parse(row.checks),
    runner: row.runner ?? null,
    approvalRef: row.approval_ref ?? null,
    notes: row.notes ?? null,
    digest: row.digest,
    schemaVersion: Number(row.schema_version),
    provenance: JSON.parse(row.provenance),
    createdAt: row.created_at,
  }
}


/** Translate a raw SQLite failure into the operator-facing code the HTTP layer renders. */
const SQLITE_CODES = [
  ['evolution_history_append_only', 'EVOLUTION_APPEND_ONLY', '历史只能追加：请写入新的 version 行，不要改写或删除既有记录'],
  ['evolution_publish_requires_validation', 'EVOLUTION_VALIDATION_REQUIRED', '先记录一条 verdict=passed 的 Validation，再发布'],
  ['evolution_owner_ref_required', 'EVOLUTION_OWNER_REF_REQUIRED', 'live 发布必须带所有者返回的版本引用 owner_ref'],
  ['evolution_already_live', 'EVOLUTION_ALREADY_LIVE', '同一资产只能有一条 live 发布；请先把旧的置为 superseded 或 rolled_back'],
  ['evolution_unknown_proposal', 'EVOLUTION_UNKNOWN_PROPOSAL', 'Validation 必须绑定该 Proposal 当前版本的 id 与 digest'],
  ['evolution_unknown_evidence', 'EVOLUTION_UNKNOWN_EVIDENCE', '请先记录这些 Evidence，再创建引用它们的 Proposal'],
  ['evolution_ticket_mismatch', 'EVOLUTION_TICKET_MISMATCH', '同一条进化链上的 ticket_id 必须一致'],
  ['evolution_derived_insufficient', 'EVOLUTION_DERIVED_INSUFFICIENT', 'Recap、Dream 与模型自评必须引用原始证据'],
  ['evolution_rollback_target_invalid', 'EVOLUTION_ROLLBACK_TARGET_INVALID', '回滚目标必须是一条已带 owner_ref 的 publish 记录'],
  ['UNIQUE constraint failed: publication.validation_id', 'EVOLUTION_VALIDATION_CONSUMED', '一条 Validation 只能支撑一次发布；重试请重新验证'],
  ['UNIQUE constraint failed: evidence.subject_id, evidence.source, evidence.dedupe_key', 'EVOLUTION_EVIDENCE_CONFLICT',
    '同一出处键已存在不同内容的证据；请改用新的 dedupeKey 或修正本次写入'],
  ['UNIQUE constraint failed', 'EVOLUTION_CONFLICT', '该记录已存在同版本行，请勿重复写入'],
  ['CHECK constraint failed', 'EVOLUTION_INVALID_RECORD', '记录不满足存储层的字段约束，请对照类型与必填项修正'],
  ['FOREIGN KEY constraint failed', 'EVOLUTION_INVALID_RECORD', '记录引用了不存在的对象'],
]

export function fromSqlite(error) {
  if (typeof error?.code === 'string' && EVOLUTION_CODES.includes(error.code)) return error
  const message = String(error?.message ?? error)
  for (const [needle, code, hint] of SQLITE_CODES) {
    if (message.includes(needle)) return new EvolutionRecordError(code, `存储层拒绝了这次写入：${message}`, hint)
  }
  return new EvolutionRecordError('EVOLUTION_STATE_CORRUPT', `Evolution 记录存储报错：${message}`,
    '请查看面板的进化诊断，必要时用备份 evolution.pre-migration-*.db 恢复；历史不会被自动重建')
}

/**
 * Copy the database aside before a migration. Refuses a file with uncheckpointed WAL
 * content, because a half copy is worse than no backup.
 */
export async function backupDatabase({ dir, file, fromVersion = EVOLUTION_SCHEMA_VERSION, now = new Date() } = {}) {
  if (!existsSync(file)) {
    fail('EVOLUTION_NOT_FOUND', `要备份的记录库不存在：${file}`, '迁移前请先打开一次存储，或确认 DSH_EVOLUTION_STATE_DIR 指向正确目录')
  }
  const wal = `${file}-wal`
  if (existsSync(wal) && statSync(wal).size > 0) {
    fail('EVOLUTION_STATE_CORRUPT', `${file} 仍有未落盘的 WAL 内容，无法安全备份`,
      '请先关闭存储或执行 PRAGMA wal_checkpoint(TRUNCATE)，再复制迁移备份')
  }
  const backups = join(dir, 'backups')
  const target = join(backups, `evolution.pre-migration-v${fromVersion}-${now.toISOString().replace(/[:.]/g, '-')}.db`)
  const created = !existsSync(backups)
  if (created) mkdirSync(backups, { recursive: true, mode: 0o700 })
  copyFileSync(file, target)
  chmodSync(target, 0o600)
  if (created) chmodSync(backups, 0o700)
  return target
}

export class EvolutionRecordStore {
  #db = null

  #paths

  #subject

  #limits

  #now

  #sequence = 0

  constructor({ db, paths, subject, now, limits }) {
    this.#db = db
    this.#paths = paths
    this.#subject = subject
    const stamp = typeof now === 'function' ? now : () => now ?? new Date()
    this.#now = () => new Date(stamp()).toISOString()
    this.#limits = { maxBytes: limits?.canonicalBytes ?? CANONICAL_LIMIT_BYTES }
  }

  get paths() {
    return this.#paths
  }

  get subject() {
    return this.#subject
  }

  isOpen() {
    return this.#db !== null
  }

  rawHandle() {
    if (!this.#db) fail('EVOLUTION_STORE_UNAVAILABLE', 'Evolution 记录存储已关闭', '请重启宿主，或用面板的诊断入口重新打开存储')
    return this.#db
  }

  /** Shared envelope head: subject and provenance come from the cross-domain contract. */
  #head(input, provenanceSource) {
    const head = envelope({
      subjectId: input.subjectId ?? this.#subject,
      schemaVersion: input.schemaVersion ?? SUBJECT_SCHEMA_VERSION,
      provenance: { source: provenanceSource, at: this.#now(), ...(input.provenance ?? {}) },
    })
    if (head.subjectId !== this.#subject) {
      fail('EVOLUTION_SUBJECT_MISMATCH',
        `这条记录属于 ${head.subjectId}，而本安装的主人仍是 ${this.#subject}`,
        '进化记录不得跨主体写入；请由对应主体的安装提交')
    }
    return head
  }

  /** The content address: identical semantics digest identically, timestamps aside. */
  #contentDigest(body, head) {
    const provenance = { ...head.provenance }
    delete provenance.at
    return digestOf({ ...body, schemaVersion: head.schemaVersion, provenance }, this.#limits)
  }

  #assertWithinCeiling(record) {
    canonicalJson(record, this.#limits)
  }

  #evidenceIdExists(id) {
    const found = this.rawHandle().prepare('SELECT 1 FROM evidence WHERE id = ? AND subject_id = ?').get(id, this.#subject)
    if (!found) {
      fail('EVOLUTION_UNKNOWN_EVIDENCE', `引用的证据 ${id} 在本主体下不存在`,
        '派生材料必须先记录它引用的原始证据')
    }
  }

  /**
   * Append one Evidence row. Same subject + source + dedupe key + content returns the
   * stored row instead of writing twice; the same key with other content conflicts.
   */
  async recordEvidence(input = {}) {
    const db = this.rawHandle()
    const { source, derived } = assertEvidenceSource(input.source, { derivedFrom: input.derivedFrom })
    const summary = assertSummary(input.summary)
    const refs = assertLocator(input.refs)
    const ticketId = assertTicket(input.ticketId, { optional: true })
    const externalId = assertShortText(input.externalId, 'externalId', MAX_TICKET_LENGTH, { optional: true })
    const derivedFrom = assertIdList(input.derivedFrom ?? [], 'derivedFrom')
    for (const id of derivedFrom) this.#evidenceIdExists(id)
    const dedupeKey = assertShortText(
      input.dedupeKey ?? digestOf({ refs, externalId: externalId ?? null, summary }, this.#limits).slice(0, 32),
      'dedupeKey',
      MAX_DEDUPE_LENGTH,
    )
    const head = this.#head(input, source)
    const body = {
      subjectId: head.subjectId,
      ticketId,
      source,
      summary,
      refs,
      derivedFrom,
      externalId: externalId ?? null,
      dedupeKey,
    }
    const digest = this.#contentDigest(body, head)
    const id = deriveRecordId('ev', { subjectId: head.subjectId, source, dedupeKey }, this.#limits)
    this.#assertWithinCeiling({ id, version: 1, ...body, digest, ...head })

    const existing = db.prepare('SELECT * FROM evidence WHERE subject_id = ? AND source = ? AND dedupe_key = ?')
      .get(head.subjectId, source, dedupeKey)
    if (existing) {
      if (existing.digest !== digest) {
        fail('EVOLUTION_EVIDENCE_CONFLICT',
          `出处键 ${dedupeKey} 已存有不同内容的证据`,
          '同一 (subjectId, source, dedupeKey) 只能对应一份内容；请用新的 dedupeKey 或修正本次写入')
      }
      return { created: false, id, version: 1, digest, record: evidenceView(existing) }
    }

    try {
      db.prepare(`INSERT INTO evidence (${EVIDENCE_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, 1, body.subjectId, ticketId, source, summary, JSON.stringify(refs), JSON.stringify(derivedFrom),
          externalId ?? null, dedupeKey, digest, head.schemaVersion, JSON.stringify(head.provenance), this.#now())
    } catch (error) {
      throw fromSqlite(error)
    }
    return { created: true, id, version: 1, digest, record: evidenceView(db.prepare('SELECT * FROM evidence WHERE id = ?').get(id)) }
  }

  /** The newest version row of one object, scoped to this installation's subject. */
  #headRow(table, id) {
    return this.rawHandle().prepare(`SELECT * FROM ${table} WHERE id = ? AND subject_id = ? ORDER BY version DESC LIMIT 1`)
      .get(id, this.#subject) ?? null
  }

  /** Column lists above are module constants, never caller input, so the SQL stays literal. */
  #insert(table, columns, values) {
    try {
      this.rawHandle().prepare(`INSERT INTO ${table} (${columns}) VALUES (${values.map(() => '?').join(', ')})`)
        .run(...values)
    } catch (error) {
      throw fromSqlite(error)
    }
  }

  /** Every cited evidence row must exist, agree on the ticket, and not be recap-only. */
  #assertEvidenceBasis(evidenceIds, ticketId) {
    const db = this.rawHandle()
    const cited = evidenceIds.map(id => {
      const row = db.prepare('SELECT * FROM evidence WHERE id = ? AND subject_id = ?').get(id, this.#subject)
      if (!row) {
        fail('EVOLUTION_UNKNOWN_EVIDENCE', `引用的证据 ${id} 在本主体下不存在`,
          '先把 Evidence 记进存储，再创建引用它的 Proposal')
      }
      return row
    })
    if (!cited.some(row => !DERIVED_ONLY_SOURCES.includes(row.source))) {
      fail('EVOLUTION_DERIVED_INSUFFICIENT', `${evidenceIds.join('、')} 全是 Recap/Dream/自评这类派生材料`,
        '候选至少要引用一条原始证据（docs/architecture.md:378）')
    }
    for (const row of cited) {
      if (row.ticket_id !== null && row.ticket_id !== ticketId) {
        fail('EVOLUTION_TICKET_MISMATCH', `证据 ${row.id} 属于 Ticket ${row.ticket_id}，与候选声明的 ${ticketId} 不一致`,
          '一条进化链上的 ticket_id 必须一致；请改用同一张 Ticket 下的证据')
      }
    }
  }

  /**
   * Append the head version of a Proposal. The candidate body is hashed and dropped,
   * so Evolution never becomes a second copy of the asset (docs/architecture.md invariant #11).
   */
  async upsertProposal(input = {}) {
    const db = this.rawHandle()
    const ticketId = assertRequiredTicket(input.ticketId)
    const ownerKind = assertCandidateOwnerPair({ candidateKind: input.candidateKind, ownerKind: input.ownerKind })
    const assetScope = assertShortText(input.assetScope, 'assetScope', MAX_ASSET_SCOPE_LENGTH)
    const summary = assertSummary(input.summary)
    const candidateRef = assertShortText(input.candidateRef, 'candidateRef', MAX_ASSET_SCOPE_LENGTH, { optional: true })
    const candidateDigest = assertDigest(
      input.candidateDigest ?? (input.candidate === undefined ? undefined : digestOf(input.candidate, this.#limits)),
      'candidateDigest',
    )
    const evidenceIds = assertIdList(input.evidenceIds ?? [], 'evidenceIds')
    if (evidenceIds.length === 0) {
      fail('EVOLUTION_INVALID_RECORD', '候选没有引用任何证据', '一条 Proposal 至少要带上一条已记录的 Evidence id')
    }
    this.#assertEvidenceBasis(evidenceIds, ticketId)
    const head = this.#head(input, 'dsh_evolution:proposal')
    const identity = {
      subjectId: head.subjectId,
      ticketId,
      candidateKind: input.candidateKind,
      ownerKind,
      assetScope,
      candidateDigest,
    }
    const body = { ...identity, summary, candidateRef, evidenceIds, state: 'proposed', reason: null }
    const digest = this.#contentDigest(body, head)
    const id = deriveRecordId('prop', identity, this.#limits)
    this.#assertWithinCeiling({ id, version: 1, ...body, digest, ...head })

    const existing = db.prepare('SELECT * FROM proposal WHERE id = ? AND subject_id = ? AND version = 1').get(id, head.subjectId)
    if (existing) {
      if (existing.digest !== digest) {
        fail('EVOLUTION_CONFLICT', `候选 ${id} 的首个版本已存有不同内容`,
          '内容变化请用 expectedProposalDigest 推进版本，或让 candidateDigest 变化生成新的 Proposal')
      }
      return { created: false, id, version: 1, digest, record: proposalView(existing) }
    }
    this.#insert('proposal', PROPOSAL_COLUMNS, [id, 1, body.subjectId, ticketId, body.candidateKind, ownerKind, assetScope,
      candidateDigest, summary, candidateRef, JSON.stringify(evidenceIds), 'proposed', null, digest,
      head.schemaVersion, JSON.stringify(head.provenance), this.#now()])
    return { created: true, id, version: 1, digest, record: proposalView(this.#headRow('proposal', id)) }
  }

  /** A state change is a new version row: the previous ones stay exactly as they were. */
  async advanceProposal(input = {}) {
    const proposalId = assertShortText(input.proposalId, 'proposalId', MAX_ID_LENGTH)
    const expectedProposalDigest = assertDigest(input.expectedProposalDigest, 'expectedProposalDigest')
    const previous = this.#headRow('proposal', proposalId)
    if (!previous) {
      fail('EVOLUTION_NOT_FOUND', `找不到候选 ${proposalId}`, '请先确认 id 与主体，或重新提交这条 Proposal')
    }
    if (expectedProposalDigest !== previous.digest) {
      fail('EVOLUTION_CONFLICT', `候选 ${proposalId} 已被其他写入推进到版本 ${previous.version}`,
        `请重新读取当前 head 的 digest（状态 ${previous.state}）后再推进，避免覆盖别人的结论`)
    }
    const toState = assertAllowedTransition('proposal', previous.state, input.toState)
    const head = this.#head(input, 'dsh_evolution:proposal')
    const reason = assertShortText(input.reason, 'reason', MAX_SUMMARY_LENGTH, { optional: true })
    const body = {
      subjectId: previous.subject_id,
      ticketId: previous.ticket_id,
      candidateKind: previous.candidate_kind,
      ownerKind: previous.owner_kind,
      assetScope: previous.asset_scope,
      candidateDigest: previous.candidate_digest,
      summary: previous.summary,
      candidateRef: previous.candidate_ref ?? null,
      evidenceIds: JSON.parse(previous.evidence_ids),
      state: toState,
      reason,
    }
    const digest = this.#contentDigest(body, head)
    const version = Number(previous.version) + 1
    this.#assertWithinCeiling({ id: proposalId, version, ...body, digest, ...head })
    this.#insert('proposal', PROPOSAL_COLUMNS, [proposalId, version, body.subjectId, body.ticketId, body.candidateKind,
      body.ownerKind, body.assetScope, body.candidateDigest, body.summary, body.candidateRef,
      JSON.stringify(body.evidenceIds), toState, reason, digest, head.schemaVersion, JSON.stringify(head.provenance), this.#now()])
    return { created: true, id: proposalId, version, digest, record: proposalView(this.#headRow('proposal', proposalId)) }
  }

  /**
   * Append a Validation. It can only bind to the head version of a Proposal, and the
   * content address ignores runner and notes, so re-running the same checks is idempotent.
   */
  async recordValidation(input = {}) {
    const db = this.rawHandle()
    const proposalId = assertShortText(input.proposalId, 'proposalId', MAX_ID_LENGTH)
    const proposal = this.#headRow('proposal', proposalId)
    if (!proposal) {
      fail('EVOLUTION_UNKNOWN_PROPOSAL', `被验证的候选 ${proposalId} 不存在`, '请先记录 Proposal，再写入它的 Validation')
    }
    const proposalDigest = assertDigest(input.proposalDigest, 'proposalDigest')
    const candidateDigest = assertDigest(input.candidateDigest, 'candidateDigest')
    if (proposalDigest !== proposal.digest) {
      fail('EVOLUTION_STALE_VALIDATION',
        `这条 Validation 绑定的是候选 ${proposalId} 的旧内容（版本 ${proposal.version} 的 digest 已变化）`,
        '请对当前 head 的 digest 重新验证；过期验证不能用来发布')
    }
    if (candidateDigest !== proposal.candidate_digest) {
      fail('EVOLUTION_STALE_VALIDATION', '验证的候选摘要与 Proposal 记录的不一致', '请重新取当前候选的 candidateDigest 再验证')
    }
    const { verdict } = input
    if (!VALIDATION_VERDICTS.includes(verdict)) {
      fail('EVOLUTION_INVALID_RECORD', `未知的验证结论 ${JSON.stringify(verdict)}`,
        `verdict 必须是 ${VALIDATION_VERDICTS.join('、')}；不要留空让它默认成通过`)
    }
    const checks = assertChecksCovered(proposal.owner_kind, input.checks)
    const ticketId = input.ticketId === undefined
      ? proposal.ticket_id
      : assertShortText(input.ticketId, 'ticketId', MAX_TICKET_LENGTH)
    if (ticketId !== proposal.ticket_id) {
      fail('EVOLUTION_TICKET_MISMATCH',
        `Validation 的 ticket ${ticketId} 与候选所属的 ${proposal.ticket_id} 不一致`,
        '一条进化链上的 ticket_id 必须一致')
    }
    const runner = assertShortText(input.runner, 'runner', MAX_ASSET_SCOPE_LENGTH, { optional: true })
    const approvalRef = assertShortText(input.approvalRef, 'approvalRef', MAX_ASSET_SCOPE_LENGTH, { optional: true })
    const notes = assertShortText(input.notes, 'notes', MAX_SUMMARY_LENGTH, { optional: true })
    const head = this.#head(input, 'dsh_evolution:validation')
    const identity = {
      subjectId: head.subjectId,
      ticketId,
      proposalId,
      proposalDigest,
      candidateDigest,
      checks,
      verdict,
    }
    const digest = this.#contentDigest(identity, head)
    const id = deriveRecordId('val', identity, this.#limits)
    this.#assertWithinCeiling({ id, version: 1, ...identity, digest, ...head })

    const existing = db.prepare('SELECT * FROM validation WHERE id = ? AND subject_id = ? AND version = 1').get(id, head.subjectId)
    if (existing) {
      return { created: false, id, version: 1, digest, record: validationView(existing) }
    }
    this.#insert('validation', VALIDATION_COLUMNS, [id, 1, head.subjectId, ticketId, proposalId, proposalDigest,
      candidateDigest, verdict, JSON.stringify(checks), runner, approvalRef, notes, digest,
      head.schemaVersion, JSON.stringify(head.provenance), this.#now()])
    return { created: true, id, version: 1, digest, record: validationView(db.prepare('SELECT * FROM validation WHERE id = ?').get(id)) }
  }

  /** Run one write batch inside a SAVEPOINT; every statement is synchronous. */
  #transaction(body) {
    const db = this.rawHandle()
    const name = `evolution_sp_${(this.#sequence += 1)}`
    db.exec(`SAVEPOINT ${name}`)
    try {
      const value = body()
      db.exec(`RELEASE ${name}`)
      return value
    } catch (error) {
      db.exec(`ROLLBACK TO ${name}`)
      db.exec(`RELEASE ${name}`)
      throw fromSqlite(error)
    }
  }

  /** Append a version row that moves a proposal to the given state, carrying identity forward. */
  #appendProposalVersion(previous, toState, reason, input) {
    const version = Number(previous.version) + 1
    const body = {
      subjectId: previous.subject_id,
      ticketId: previous.ticket_id,
      candidateKind: previous.candidate_kind,
      ownerKind: previous.owner_kind,
      assetScope: previous.asset_scope,
      candidateDigest: previous.candidate_digest,
      summary: previous.summary,
      candidateRef: previous.candidate_ref ?? null,
      evidenceIds: JSON.parse(previous.evidence_ids),
      state: toState,
      reason,
    }
    const head = this.#head(input, 'dsh_evolution:proposal')
    const digest = this.#contentDigest(body, head)
    this.#insert('proposal', PROPOSAL_COLUMNS, [previous.id, version, body.subjectId, body.ticketId, body.candidateKind,
      body.ownerKind, body.assetScope, body.candidateDigest, body.summary, body.candidateRef,
      JSON.stringify(body.evidenceIds), toState, reason, digest, head.schemaVersion, JSON.stringify(head.provenance),
      this.#now()])
    return { id: previous.id, version, digest }
  }

  /** The publication row that is currently live for one asset, subject-scoped. */
  #livePublication(assetScope) {
    const row = this.rawHandle().prepare(`SELECT * FROM publication p
      WHERE p.asset_scope = ? AND p.subject_id = ? AND p.state = 'live'
        AND p.version = (SELECT max(q.version) FROM publication q WHERE q.id = p.id AND q.subject_id = p.subject_id)
      LIMIT 1`).get(assetScope, this.#subject)
    return row ?? null
  }

  /** Retiring a publication is a new version row; the earlier rows stay readable (invariant #15). */
  #retirePublication(row, toState, input) {
    assertAllowedTransition('publication', row.state, toState)
    const body = {
      subjectId: row.subject_id,
      ticketId: row.ticket_id,
      proposalId: row.proposal_id,
      proposalDigest: row.proposal_digest,
      candidateDigest: row.candidate_digest,
      validationId: row.validation_id ?? null,
      purpose: row.purpose,
      ownerKind: row.owner_kind,
      assetScope: row.asset_scope,
      ownerRef: row.owner_ref === null || row.owner_ref === undefined ? null : JSON.parse(row.owner_ref),
      supersedesPublicationId: row.supersedes_publication_id ?? null,
      restoredFromPublicationId: row.restored_from_publication_id ?? null,
      state: toState,
      error: row.error ?? null,
    }
    const head = this.#head(input, 'dsh_evolution:publication')
    const digest = this.#contentDigest(body, head)
    const version = Number(row.version) + 1
    this.#insertPublicationRow({
      id: row.id, version, body, digest, head, approvalRefs: JSON.parse(row.approval_refs),
      actorRef: row.actor_ref ?? null, publishedAt: row.published_at ?? null,
    })
    return { id: row.id, version, digest }
  }

  #insertPublicationRow({ id, version, body, digest, head, approvalRefs, actorRef, publishedAt }) {
    this.#insert('publication', PUBLICATION_COLUMNS, [
      id, version, body.subjectId, body.ticketId, body.proposalId, body.proposalDigest, body.candidateDigest,
      body.validationId, body.purpose, body.ownerKind, body.assetScope,
      body.ownerRef === null || body.ownerRef === undefined ? null : JSON.stringify(body.ownerRef),
      body.supersedesPublicationId, body.restoredFromPublicationId, body.state, body.error,
      JSON.stringify(approvalRefs ?? []), actorRef ?? null, publishedAt ?? null, digest, head.schemaVersion,
      JSON.stringify(head.provenance), this.#now(),
    ])
  }

  /**
   * Record that an owner published a validated candidate. The caller brings the owner's own
   * version reference; Evolution never writes the asset itself (invariant #11).
   */
  async publish(input = {}, options = {}) {
    const db = this.rawHandle()
    const proposalId = assertShortText(input.proposalId, 'proposalId', MAX_ID_LENGTH)
    const proposal = this.#headRow('proposal', proposalId)
    if (!proposal) {
      fail('EVOLUTION_NOT_FOUND', `找不到候选 ${proposalId}`, '请先记录并验证 Proposal，再谈发布')
    }
    if (proposal.owner_kind === 'mempalace' && options.viaOwnerApi !== true) {
      fail('EVOLUTION_OWNER_API_REQUIRED',
        `${proposalId} 属于 MemPalace，必须经所有者接口发布`,
        '请使用 POST /dsh-evolution/api/publish-knowledge；通用 /publish 不接受 MemPalace 的自报 ownerRef')
    }
    if (!ownerAllowsPublish(proposal.owner_kind)) {
      fail('EVOLUTION_OWNER_UNSUPPORTED',
        `${proposal.owner_kind} 还没有版本化写入能力，${proposalId} 不能发布`,
        `候选保持 Proposal，直到 ${proposal.owner_kind} 提供可回滚的写入接口（docs/architecture.md:391）`)
    }
    const expectedProposalDigest = assertDigest(input.expectedProposalDigest, 'expectedProposalDigest')
    if (input.validationId === undefined || input.validationId === null || !String(input.validationId).trim()) {
      fail('EVOLUTION_VALIDATION_REQUIRED', `候选 ${proposalId} 还没有通过验证`,
        '先记录一条 verdict=passed 的 Validation，再发布；没有验证就没有发布')
    }
    const validationId = assertShortText(input.validationId, 'validationId', MAX_ID_LENGTH)
    const ownerRef = assertOwnerRef(proposal.owner_kind, input.ownerRef)
    const head = this.#head(input, 'dsh_evolution:publication')
    // A publish is named by the candidate it publishes and the validation that cleared it, never by the clock.
    const id = deriveRecordId('pub', { subjectId: head.subjectId, proposalId: proposal.id, validationId, purpose: 'publish' },
      this.#limits)
    const existing = db.prepare('SELECT * FROM publication WHERE id = ? AND subject_id = ? AND version = 1')
      .get(id, head.subjectId)
    if (existing) {
      const storedRef = assertOwnerRef(existing.owner_kind, JSON.parse(existing.owner_ref ?? 'null'))
      if (existing.owner_kind === proposal.owner_kind && existing.asset_scope === proposal.asset_scope
        && existing.ticket_id === proposal.ticket_id
        && digestOf(storedRef, this.#limits) === digestOf(ownerRef, this.#limits)) {
        return { created: false, id, version: 1, digest: existing.digest, record: publicationView(this.#headRow('publication', id)) }
      }
      fail('EVOLUTION_VALIDATION_CONSUMED', `验证 ${validationId} 已经支撑过一次发布`,
        '一条 Validation 只能支撑一次发布；换了内容请重新验证，不要拿旧结论重试')
    }
    if (expectedProposalDigest !== proposal.digest) {
      fail('EVOLUTION_CONFLICT', `候选 ${proposalId} 的当前内容与你给出的 expectedProposalDigest 不一致`,
        `请重新读取 head（版本 ${proposal.version}，状态 ${proposal.state}）的 digest 再发布，避免发布别人已经改过的版本`)
    }
    const validation = db.prepare('SELECT * FROM validation WHERE id = ? AND subject_id = ? ORDER BY version DESC LIMIT 1')
      .get(validationId, this.#subject)
    if (!validation) {
      fail('EVOLUTION_VALIDATION_REQUIRED', `找不到验证记录 ${validationId}`, 'Validation 必须先于发布写入；请确认 id 与主体')
    }
    if (validation.proposal_id !== proposal.id) {
      fail('EVOLUTION_VALIDATION_REQUIRED', `验证 ${validationId} 检验的是 ${validation.proposal_id}，不是这条候选`,
        '请改用本候选自己的 Validation 来发布')
    }
    if (validation.verdict !== 'passed') {
      fail('EVOLUTION_VALIDATION_REQUIRED', `验证 ${validationId} 的结论是 ${validation.verdict}`,
        '只有 passed 的验证才允许发布；失败或被挡住的候选留在队列里')
    }
    if (validation.proposal_digest !== proposal.digest || validation.candidate_digest !== proposal.candidate_digest) {
      fail('EVOLUTION_STALE_VALIDATION', `验证 ${validationId} 绑的是候选 ${proposal.id} 的旧内容`,
        '请对当前 head 的 digest 重新验证后再发布')
    }
    assertAllowedTransition('proposal', proposal.state, 'published')
    const live = this.#livePublication(proposal.asset_scope)
    this.#assertExpectedLive(input, proposal.asset_scope, live)
    const approvalRefs = assertIdList(input.approvalRefs ?? [], 'approvalRefs')
    const actorRef = assertShortText(input.actorRef, 'actorRef', MAX_ASSET_SCOPE_LENGTH, { optional: true })
    const reason = assertShortText(input.reason ?? input.error, 'reason', MAX_SUMMARY_LENGTH, { optional: true })
    const body = {
      subjectId: head.subjectId,
      ticketId: proposal.ticket_id,
      proposalId: proposal.id,
      proposalDigest: proposal.digest,
      candidateDigest: proposal.candidate_digest,
      validationId,
      purpose: 'publish',
      ownerKind: proposal.owner_kind,
      assetScope: proposal.asset_scope,
      ownerRef,
      supersedesPublicationId: live ? live.id : null,
      restoredFromPublicationId: null,
      state: 'live',
      error: reason,
    }
    const digest = this.#contentDigest(body, head)
    this.#assertWithinCeiling({ id, version: 1, ...body, digest, ...head })
    const publishedAt = this.#now()
    this.#transaction(() => {
      this.#appendProposalVersion(proposal, 'published', `发布 ${id}`, input)
      if (live) this.#retirePublication(live, 'superseded', input)
      this.#insertPublicationRow({ id, version: 1, body, digest, head, approvalRefs, actorRef, publishedAt })
    })
    return { created: true, id, version: 1, digest, record: publicationView(this.#headRow('publication', id)) }
  }

  /**
   * Restore an asset to an earlier publication by appending a new live row. Nothing is
   * deleted: the row being undone gains a `rolled_back` version (invariant #15).
   */
  async rollback(input = {}, options = {}) {
    const db = this.rawHandle()
    const restoredFromPublicationId = assertShortText(input.restoredFromPublicationId, 'restoredFromPublicationId',
      MAX_ID_LENGTH)
    const target = this.#headRow('publication', restoredFromPublicationId)
    if (!target) {
      fail('EVOLUTION_ROLLBACK_TARGET_INVALID', `找不到要恢复的发布 ${restoredFromPublicationId}`,
        '回滚必须指向一条本主体写下、且带 owner_ref 的 publish 记录')
    }
    if (target.owner_kind === 'mempalace' && options.viaOwnerApi !== true) {
      fail('EVOLUTION_OWNER_API_REQUIRED',
        `${restoredFromPublicationId} 属于 MemPalace，必须经所有者接口回滚`,
        '请使用 POST /dsh-evolution/api/rollback-knowledge；通用 /rollback 不接受 MemPalace 的自报 ownerRef')
    }
    if (target.purpose !== 'publish') {
      fail('EVOLUTION_ROLLBACK_TARGET_INVALID', `${restoredFromPublicationId} 是一条 ${target.purpose} 记录，不能当作恢复目标`,
        '回滚要把资产恢复到某次真实发布过的版本；请直接发布那条候选')
    }
    const ownerRef = assertOwnerRef(target.owner_kind, input.ownerRef)
    const live = this.#livePublication(target.asset_scope)
    if (!live) {
      fail('EVOLUTION_ROLLBACK_TARGET_INVALID', `资产 ${target.asset_scope} 当前没有 live 发布`,
        '没有生效版本就无从回滚；请先发布一条，或确认 assetScope 是否写错')
    }
    if (live.id === target.id) {
      fail('EVOLUTION_ROLLBACK_TARGET_INVALID', `${target.id} 已经是资产 ${target.asset_scope} 的当前 live 发布`,
        '回滚的目标必须是更早的那次发布，而不是正在生效的这条')
    }
    this.#assertExpectedLive(input, target.asset_scope, live)
    const approvalRefs = assertIdList(input.approvalRefs ?? [], 'approvalRefs')
    const actorRef = assertShortText(input.actorRef, 'actorRef', MAX_ASSET_SCOPE_LENGTH, { optional: true })
    const reason = assertShortText(input.reason ?? input.error, 'reason', MAX_SUMMARY_LENGTH, { optional: true })
    const head = this.#head(input, 'dsh_evolution:publication')
    const body = {
      subjectId: head.subjectId,
      ticketId: target.ticket_id,
      proposalId: target.proposal_id,
      proposalDigest: target.proposal_digest,
      candidateDigest: target.candidate_digest,
      validationId: null,
      purpose: 'rollback',
      ownerKind: target.owner_kind,
      assetScope: target.asset_scope,
      ownerRef,
      supersedesPublicationId: live.id,
      restoredFromPublicationId,
      state: 'live',
      error: reason,
    }
    const digest = this.#contentDigest(body, head)
    const id = deriveRecordId('pub', {
      subjectId: head.subjectId,
      proposalId: target.proposal_id,
      validationId: null,
      purpose: 'rollback',
      restoredFromPublicationId,
    }, this.#limits)
    this.#assertWithinCeiling({ id, version: 1, ...body, digest, ...head })
    const existing = db.prepare('SELECT * FROM publication WHERE id = ? AND subject_id = ? AND version = 1')
      .get(id, head.subjectId)
    if (existing) {
      if (existing.digest === digest) {
        return { created: false, id, version: 1, digest, record: publicationView(this.#headRow('publication', id)) }
      }
      fail('EVOLUTION_CONFLICT', `${target.asset_scope} 已经按 ${restoredFromPublicationId} 回滚过一次，且内容不同`,
        '请重新读取当前的 live 发布；要再次改变资产内容请走新的 Proposal')
    }
    const publishedAt = this.#now()
    this.#transaction(() => {
      this.#retirePublication(live, 'rolled_back', input)
      this.#insertPublicationRow({ id, version: 1, body, digest, head, approvalRefs, actorRef, publishedAt })
    })
    return { created: true, id, version: 1, digest, record: publicationView(this.#headRow('publication', id)) }
  }

  /**
   * Publish a MemPalace knowledge revision through the owner. The owner writes the asset;
   * Evolution only learns the revision reference and records it, so the two stores cannot
   * disagree about which revision is live.
   */
  async publishKnowledge(input = {}, owner) {
    if (!owner || typeof owner.commit !== 'function' || typeof owner.status !== 'function') {
      fail('EVOLUTION_OWNER_FAILED', '没有可用的 MemPalace 所有者接口', '确认 dsh-mempalace 正在运行，并已加载内部 IPC')
    }
    const db = this.rawHandle()
    const proposalId = assertShortText(input.proposalId, 'proposalId', MAX_ID_LENGTH)
    const proposal = this.#headRow('proposal', proposalId)
    if (!proposal) fail('EVOLUTION_NOT_FOUND', `找不到候选 ${proposalId}`, '请先记录并验证 Proposal，再发布')
    if (proposal.owner_kind !== 'mempalace') {
      fail('EVOLUTION_INVALID_RECORD', `${proposalId} 不属于 MemPalace`, '知识发布只接受 owner_kind=mempalace 的候选')
    }
    const expectedProposalDigest = assertDigest(input.expectedProposalDigest, 'expectedProposalDigest')
    if (expectedProposalDigest !== proposal.digest) {
      fail('EVOLUTION_CONFLICT', `候选 ${proposalId} 的当前内容与你给出的 expectedProposalDigest 不一致`,
        '请重新读取 head 的 digest 再发布')
    }
    const validationId = assertShortText(input.validationId, 'validationId', MAX_ID_LENGTH)
    const validation = db.prepare('SELECT * FROM validation WHERE id = ? AND subject_id = ? ORDER BY version DESC LIMIT 1')
      .get(validationId, this.#subject)
    if (!validation) fail('EVOLUTION_VALIDATION_REQUIRED', `找不到验证记录 ${validationId}`, 'Validation 必须先于发布写入')
    if (validation.proposal_id !== proposal.id) fail('EVOLUTION_VALIDATION_REQUIRED', `验证 ${validationId} 检验的不是这条候选`, '请改用本候选自己的 Validation')
    if (validation.verdict !== 'passed') fail('EVOLUTION_VALIDATION_REQUIRED', `验证 ${validationId} 的结论是 ${validation.verdict}`, '只有 passed 的验证才允许发布')
    if (validation.proposal_digest !== proposal.digest || validation.candidate_digest !== proposal.candidate_digest) {
      fail('EVOLUTION_STALE_VALIDATION', `验证 ${validationId} 绑的是旧内容`, '请对当前 head 的 digest 重新验证后再发布')
    }
    assertAllowedTransition('proposal', proposal.state, 'published')
    const candidate = input.candidate
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      fail('EVOLUTION_INVALID_RECORD', 'publish-knowledge 需要 candidate 正文', '候选正文留在所有者侧校验，Evolution 只记录摘要')
    }
    if (candidate.assetScope !== proposal.asset_scope) fail('EVOLUTION_INVALID_RECORD', 'candidate.assetScope 与 Proposal 不一致', '请使用同一条资产的候选')
    if (digestOf(candidate, this.#limits) !== proposal.candidate_digest) {
      fail('EVOLUTION_CONFLICT', `候选 ${proposalId} 的正文摘要与 Proposal 不一致`, '候选可能已被改写；请重新提交 Proposal 并验证')
    }
    const baseRevision = Number(candidate.baseRevision)
    if (!Number.isInteger(baseRevision) || baseRevision < 0) {
      fail('EVOLUTION_INVALID_RECORD', 'candidate.baseRevision 必须是非负整数', '它是知识写入的 CAS 锚点')
    }
    const live = this.#livePublication(proposal.asset_scope)
    this.#assertExpectedLive(input, proposal.asset_scope, live)
    const commitKey = input.commitKey === undefined
      ? `evo:${proposal.id}:${validationId}`
      : assertShortText(input.commitKey, 'commitKey', MAX_ID_LENGTH)
    let committed
    try {
      committed = await owner.commit({
        assetScope: proposal.asset_scope,
        commitKey,
        expectedRevision: baseRevision,
        ops: candidate.ops,
        checks: candidate.checks,
        provenance: candidate.provenance ?? {},
      })
    } catch (error) {
      committed = await this.#reconcileOwner(owner, commitKey)
      if (!committed) {
        fail('EVOLUTION_OWNER_FAILED', `MemPalace 提交 ${commitKey} 失败且结果未知`,
          `先查询 MemPalace 的 knowledgeStatus(commitKey=${commitKey}) 再决定；不要盲目重试。底层错误：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const ownerRef = this.#knowledgeRef(committed)
    if (!ownerRef) {
      await this.#compensate(owner, committed, baseRevision, commitKey, proposal.asset_scope)
      fail('EVOLUTION_OWNER_FAILED', `MemPalace 提交 ${commitKey} 没有返回完整版本引用`,
        'Evolution 已尝试把知识回滚到提交前；请检查 MemPalace 的 knowledgeStatus')
    }
    try {
      const published = await this.publish({
        proposalId,
        expectedProposalDigest,
        validationId,
        ownerRef,
        ...(input.expectedLivePublicationId !== undefined ? { expectedLivePublicationId: input.expectedLivePublicationId } : {}),
        ...(input.expectedLiveDigest !== undefined ? { expectedLiveDigest: input.expectedLiveDigest } : {}),
        approvalRefs: input.approvalRefs,
        actorRef: input.actorRef,
        reason: input.reason ?? input.error,
      }, { viaOwnerApi: true })
      return { ...published, ownerRef }
    } catch (error) {
      await this.#compensate(owner, committed, baseRevision, commitKey, proposal.asset_scope)
      fail('EVOLUTION_OWNER_FAILED', `知识已提交但 Evolution 发布记录失败：${error instanceof Error ? error.message : String(error)}`,
        '知识已尝试回滚到提交前；不要直接重试 publish-knowledge，先核对 knowledgeStatus 与 publication')
    }
  }

  /** Roll a MemPalace asset back through the owner, then append the matching publication record. */
  async rollbackKnowledge(input = {}, owner) {
    if (!owner || typeof owner.rollback !== 'function' || typeof owner.status !== 'function') {
      fail('EVOLUTION_OWNER_FAILED', '没有可用的 MemPalace 所有者接口', '确认 dsh-mempalace 正在运行')
    }
    const restoredFromPublicationId = assertShortText(input.restoredFromPublicationId, 'restoredFromPublicationId', MAX_ID_LENGTH)
    const target = this.#headRow('publication', restoredFromPublicationId)
    if (!target) fail('EVOLUTION_ROLLBACK_TARGET_INVALID', `找不到要恢复的发布 ${restoredFromPublicationId}`, '回滚必须指向一条 publish 记录')
    if (target.owner_kind !== 'mempalace') fail('EVOLUTION_INVALID_RECORD', `${restoredFromPublicationId} 不属于 MemPalace`, '知识回滚只接受 MemPalace 的发布')
    if (target.purpose !== 'publish') fail('EVOLUTION_ROLLBACK_TARGET_INVALID', `${restoredFromPublicationId} 不是 publish 记录`, '请直接发布那条候选')
    const live = this.#livePublication(target.asset_scope)
    if (!live) fail('EVOLUTION_ROLLBACK_TARGET_INVALID', `资产 ${target.asset_scope} 当前没有 live 发布`, '没有生效版本就无从回滚')
    if (live.id === target.id) fail('EVOLUTION_ROLLBACK_TARGET_INVALID', `${target.id} 已经是 live 发布`, '回滚目标必须是更早的发布')
    this.#assertExpectedLive(input, target.asset_scope, live)
    const targetRef = assertOwnerRef('mempalace', JSON.parse(target.owner_ref))
    const liveRef = assertOwnerRef('mempalace', JSON.parse(live.owner_ref))
    if (Number(targetRef.revision) >= Number(liveRef.revision)) {
      fail('EVOLUTION_ROLLBACK_TARGET_INVALID', '目标版本不早于当前 live 版本', 'MemPalace 修订号必须严格递增')
    }
    const commitKey = input.commitKey === undefined
      ? `evo:rollback:${target.id}:${live.id}`
      : assertShortText(input.commitKey, 'commitKey', MAX_ID_LENGTH)
    let rolled
    try {
      rolled = await owner.rollback({
        assetScope: target.asset_scope,
        commitKey,
        targetRevision: Number(targetRef.revision),
        reason: input.reason ?? input.error,
      })
    } catch (error) {
      rolled = await this.#reconcileOwner(owner, commitKey)
      if (!rolled) {
        fail('EVOLUTION_OWNER_FAILED', `MemPalace 回滚 ${commitKey} 失败且结果未知`,
          `先查询 knowledgeStatus(commitKey=${commitKey}) 再决定；不要盲目重试。底层错误：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const ownerRef = this.#knowledgeRef(rolled)
    if (!ownerRef) fail('EVOLUTION_OWNER_FAILED', `MemPalace 回滚 ${commitKey} 没有返回完整版本引用`, '请检查 knowledgeStatus')
    try {
      return {
        ...(await this.rollback({
          restoredFromPublicationId,
          ownerRef,
          ...(input.expectedLivePublicationId !== undefined ? { expectedLivePublicationId: input.expectedLivePublicationId } : {}),
          ...(input.expectedLiveDigest !== undefined ? { expectedLiveDigest: input.expectedLiveDigest } : {}),
          approvalRefs: input.approvalRefs,
          actorRef: input.actorRef,
          reason: input.reason ?? input.error,
        }, { viaOwnerApi: true })),
        ownerRef,
      }
    } catch (error) {
      fail('EVOLUTION_OWNER_FAILED', `知识已回滚但 Evolution 回滚记录失败：${error instanceof Error ? error.message : String(error)}`,
        `知识已经回滚；用相同的输入与 commitKey（${commitKey}）重新调用 rollback-knowledge 即可安全补齐发布记录，所有者回滚按 commitKey 幂等。请先核对 MemPalace 的 knowledgeStatus 与 Evolution 的 publication 列表`)
    }
  }

  /** Only a complete live version reference proves the owner wrote usable knowledge; the publish path compensates anything less. */
  #knowledgeRef(value) {
    if (!value || typeof value !== 'object') return undefined
    // A compensated or rolled-back revision is dead: recording it would claim a live publication nobody has.
    if (value.state !== 'live') return undefined
    const knowledgeId = typeof value.knowledgeId === 'string' && value.knowledgeId ? value.knowledgeId : undefined
    const revision = Number(value.revision)
    const digest = typeof value.digest === 'string' && /^[0-9a-f]{64}$/.test(value.digest) ? value.digest : undefined
    return knowledgeId && Number.isInteger(revision) && revision > 0 && digest ? { knowledgeId, revision, digest } : undefined
  }

  /** An unknown RPC outcome is resolved by asking the owner, never by retrying the write. */
  async #reconcileOwner(owner, commitKey) {
    try {
      const status = await owner.status({ commitKeys: [commitKey] })
      const found = status?.commits?.find(commit => commit.commitKey === commitKey)
      return found ?? undefined
    } catch { return undefined }
  }

  async #compensate(owner, committed, baseRevision, commitKey, assetScope) {
    try {
      await owner.rollback({
        assetScope: committed?.assetScope ?? assetScope,
        knowledgeId: committed?.knowledgeId,
        commitKey: `${commitKey}:compensate`,
        targetRevision: baseRevision,
        reason: 'evolution publication recording failed',
      })
    } catch { /* the caller reports both failures through EVOLUTION_OWNER_FAILED */ }
  }

  /** NULL-safe compare-and-set against the publication the caller believes is live, plus its digest. */
  #assertExpectedLive(input, assetScope, live) {
    if (Object.hasOwn(input, 'expectedLivePublicationId')) {
      const expected = input.expectedLivePublicationId === null || input.expectedLivePublicationId === undefined
        ? null
        : assertShortText(input.expectedLivePublicationId, 'expectedLivePublicationId', MAX_ID_LENGTH)
      const current = live ? live.id : null
      if (expected !== current) {
        fail('EVOLUTION_CONFLICT', `资产 ${assetScope} 的 live 发布是 ${current ?? '（无）'}，与你预期的 ${expected ?? '（无）'} 不一致`,
          '请重新读取该资产的 live 发布再写入；live 变化说明有人先动了这个资产')
      }
    }
    if (input.expectedLiveDigest !== undefined) {
      const expected = assertDigest(input.expectedLiveDigest, 'expectedLiveDigest')
      const current = live?.digest ?? null
      if (expected !== current) {
        fail('EVOLUTION_CONFLICT', `资产 ${assetScope} 的 live 发布摘要与你给出的 expectedLiveDigest 不一致`,
          '请重新读取该资产的 live 发布再写入；摘要变化说明有人先动了这个资产')
      }
    }
  }

  /**
   * Re-derive every stored digest and every link, so a record that was rewritten outside
   * this plugin (a copied file, a hand-edited row) shows up instead of silently shipping.
   */
  async verifyHistory(options = {}) {
    const db = this.rawHandle()
    const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : null
    const integrityRow = db.prepare('PRAGMA integrity_check').get()
    const integrityCheck = String(integrityRow?.integrity_check ?? integrityRow ?? 'unknown')
    const digestMismatches = []
    let rows = 0
    let truncated = false
    for (const table of ['evidence', 'proposal', 'validation', 'publication']) {
      for (const row of db.prepare(`SELECT * FROM ${table} ORDER BY id, version`).all()) {
        if (limit !== null && rows >= limit) {
          truncated = true
          break
        }
        rows += 1
        if (digestOfStoredRow(table, row, this.#limits) !== row.digest) {
          digestMismatches.push({ table, id: row.id, version: Number(row.version) })
        }
      }
      if (truncated) break
    }
    const gaps = db.prepare(`SELECT id, count(*) AS rows, max(version) AS head FROM publication
      GROUP BY id HAVING rows <> head`).all().map(row => row.id)
    const danglingPublications = db.prepare(`SELECT p.id FROM publication p
      WHERE p.version = 1 AND NOT EXISTS (SELECT 1 FROM proposal q WHERE q.id = p.proposal_id AND q.subject_id = p.subject_id)`)
      .all().map(row => row.id)
    const unvalidated = db.prepare(`SELECT id FROM publication WHERE purpose = 'publish' AND state = 'live'
      AND NOT EXISTS (SELECT 1 FROM validation v WHERE v.id = publication.validation_id AND v.verdict = 'passed'
        AND v.proposal_digest = publication.proposal_digest AND v.candidate_digest = publication.candidate_digest)`)
      .all().map(row => row.id)
    const doubleLive = db.prepare(`SELECT asset_scope FROM publication p WHERE p.state = 'live'
      AND p.version = (SELECT max(q.version) FROM publication q WHERE q.id = p.id)
      GROUP BY asset_scope HAVING count(*) > 1`).all().map(row => row.asset_scope)
    const present = new Set(db.prepare('SELECT name FROM sqlite_master WHERE type = ?').all('trigger').map(row => row.name))
    const missingTriggers = [...APPEND_TRIGGERS, ...DOMAIN_TRIGGERS].filter(name => !present.has(name))
    const linkIssues = [
      ...gaps.map(id => ({ table: 'publication', id, issue: 'version 序列有缺口' })),
      ...danglingPublications.map(id => ({ table: 'publication', id, issue: '引用了不存在的 Proposal' })),
      ...unvalidated.map(id => ({ table: 'publication', id, issue: 'live 发布缺少相符的 passed 验证' })),
      ...doubleLive.map(scope => ({ table: 'publication', assetScope: scope, issue: '同一资产有多条 live' })),
    ]
    const ok = integrityCheck === 'ok' && digestMismatches.length === 0 && linkIssues.length === 0
      && missingTriggers.length === 0
    return { ok, integrityCheck, rows, truncated, digestMismatches, linkIssues, missingTriggers }
  }

  /** One record at its head, with the whole version trail on request. */
  async getRecord(id, options = {}) {
    const db = this.rawHandle()
    const recordId = assertShortText(id, 'id', MAX_ID_LENGTH)
    const withHistory = options.history === true || options.history === 'true' || Number(options.history) === 1
    for (const kind of RECORD_KINDS) {
      const head = this.#headRow(kind, recordId)
      if (!head) continue
      const result = { id: recordId, kind, record: RECORD_VIEWS[kind](head) }
      if (withHistory) {
        result.history = db.prepare(`SELECT * FROM ${kind} WHERE id = ? AND subject_id = ? ORDER BY version`)
          .all(recordId, this.#subject).map(RECORD_VIEWS[kind])
      }
      return result
    }
    return null
  }

  /** Everything this installation recorded for one Superagent ticket, grouped by kind. */
  async listByTicket(ticketId, options = {}) {
    const db = this.rawHandle()
    const ticket = assertTicket(ticketId)
    const kinds = Array.isArray(options.kinds) && options.kinds.length > 0
      ? options.kinds.map(kind => assertFilterEnum(kind, 'kind', RECORD_KINDS))
      : [...RECORD_KINDS]
    const state = assertFilterEnum(options.state, 'state',
      [...new Set([...Object.keys(PROPOSAL_TRANSITIONS), ...Object.keys(PUBLICATION_TRANSITIONS)])])
    const { limit } = pageOptions(options)
    const group = { ticketId: ticket }
    for (const kind of kinds) {
      const usesState = state !== undefined && (kind === 'proposal' || kind === 'publication')
      const sql = `${TICKET_SQL[kind]}${usesState ? ' AND state = ?' : ''} ORDER BY created_at, id LIMIT ?`
      const params = [ticket, this.#subject]
      if (usesState) params.push(state)
      params.push(limit)
      group[GROUP_NAMES[kind]] = db.prepare(sql).all(...params).map(RECORD_VIEWS[kind])
    }
    return group
  }

  /** Head rows only: one object shows up once, however many versions it has accumulated. */
  #list(table, options, conditions) {
    const db = this.rawHandle()
    const { limit, offset } = pageOptions(options)
    const where = ['subject_id = ?']
    const params = [this.#subject]
    for (const [clause, value] of conditions) {
      if (value === undefined || value === null || value === '') continue
      where.push(clause)
      params.push(value)
    }
    where.push(table === 'evidence' ? 'version = 1'
      : `version = (SELECT max(q.version) FROM ${table} q WHERE q.id = ${table}.id)`)
    const from = `FROM ${table} WHERE ${where.join(' AND ')}`
    const total = Number(db.prepare(`SELECT count(*) AS n ${from}`).get(...params).n)
    const rows = db.prepare(`SELECT * ${from} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset)
    return { items: rows.map(RECORD_VIEWS[table]), total, limit, offset }
  }

  async listEvidence(options = {}) {
    return this.#list('evidence', options, [
      ['ticket_id = ?', assertTicket(options.ticketId, { optional: true })],
      ['source = ?', assertFilterEnum(options.source, 'source', EVIDENCE_SOURCES)],
    ])
  }

  async listProposals(options = {}) {
    return this.#list('proposal', options, [
      ['ticket_id = ?', assertTicket(options.ticketId, { optional: true })],
      ['state = ?', assertFilterEnum(options.state, 'state', Object.keys(PROPOSAL_TRANSITIONS))],
      ['candidate_kind = ?', assertFilterEnum(options.candidateKind, 'candidateKind', CANDIDATE_KINDS)],
      ['owner_kind = ?', assertFilterEnum(options.ownerKind, 'ownerKind', Object.keys(OWNERS))],
      ['asset_scope = ?', assertShortText(options.assetScope, 'assetScope', MAX_ASSET_SCOPE_LENGTH, { optional: true })],
    ])
  }

  async listValidations(options = {}) {
    return this.#list('validation', options, [
      ['proposal_id = ?', assertShortText(options.proposalId, 'proposalId', MAX_ID_LENGTH, { optional: true })],
      ['ticket_id = ?', assertTicket(options.ticketId, { optional: true })],
      ['verdict = ?', assertFilterEnum(options.verdict, 'verdict', VALIDATION_VERDICTS)],
    ])
  }

  async listPublications(options = {}) {
    return this.#list('publication', options, [
      ['proposal_id = ?', assertShortText(options.proposalId, 'proposalId', MAX_ID_LENGTH, { optional: true })],
      ['ticket_id = ?', assertTicket(options.ticketId, { optional: true })],
      ['asset_scope = ?', assertShortText(options.assetScope, 'assetScope', MAX_ASSET_SCOPE_LENGTH, { optional: true })],
      ['state = ?', assertFilterEnum(options.state, 'state', Object.keys(PUBLICATION_TRANSITIONS))],
      ['purpose = ?', assertFilterEnum(options.purpose, 'purpose', PUBLICATION_PURPOSES)],
    ])
  }

  async status() {
    const db = this.rawHandle()
    const triggers = db.prepare('SELECT name FROM sqlite_master WHERE type = ? ORDER BY name').all('trigger').map(row => row.name)
    return {
      available: true,
      dir: this.#paths.dir,
      file: this.#paths.file,
      subjectId: this.#subject,
      schemaVersion: Number(readPragma(db, 'user_version')),
      minSupportedSchema: MIN_SUPPORTED_SCHEMA,
      journalMode: readPragma(db, 'journal_mode'),
      synchronous: Number(readPragma(db, 'synchronous')),
      foreignKeys: Number(readPragma(db, 'foreign_keys')),
      busyTimeoutMs: Number(readPragma(db, 'busy_timeout')),
      applicationId: Number(readPragma(db, 'application_id')),
      triggers,
      appendOnlyGuards: APPEND_TRIGGERS.filter(name => triggers.includes(name)).length,
    }
  }

  /** Counts plus the current state of every object; never throws, so /overview can degrade. */
  async summary() {
    const db = this.rawHandle()
    const rows = table => Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n)
    const byState = table => Object.fromEntries(db.prepare(
      `SELECT state, count(*) AS n FROM ${table} p
       WHERE p.version = (SELECT max(q.version) FROM ${table} q WHERE q.id = p.id)
       GROUP BY state ORDER BY state`).all().map(row => [row.state, Number(row.n)]))
    const live = db.prepare(`SELECT id, asset_scope, owner_kind, proposal_id FROM publication p
      WHERE p.state = 'live' AND p.version = (SELECT max(q.version) FROM publication q WHERE q.id = p.id)
      ORDER BY created_at DESC LIMIT 50`).all()
      .map(row => ({ id: row.id, assetScope: row.asset_scope, ownerKind: row.owner_kind, proposalId: row.proposal_id }))
    return {
      available: true,
      counts: { evidence: rows('evidence'), proposal: rows('proposal'), validation: rows('validation'), publication: rows('publication') },
      proposalsByState: byState('proposal'),
      publicationsByState: byState('publication'),
      livePublications: live,
      tickets: Number(db.prepare('SELECT count(DISTINCT ticket_id) AS n FROM proposal').get().n),
    }
  }

  async summarySafe() {
    try {
      return await this.summary()
    } catch (error) {
      const typed = fromSqlite(error)
      return { available: false, code: typed.code, error: typed.message, hint: typed.hint ?? undefined }
    }
  }

  async close() {
    const db = this.#db
    this.#db = null
    if (!db) return
    try {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    } catch {
      // best effort: a locked checkpoint must never keep the host from shutting down
    }
    db.close()
  }
}

export const APPEND_TRIGGERS = ['evidence_no_update', 'evidence_no_delete', 'proposal_no_update', 'proposal_no_delete',
  'validation_no_update', 'validation_no_delete', 'publication_no_update', 'publication_no_delete']

/** The library-level acceptance rules: each one makes an invalid state unrepresentable. */
export const DOMAIN_TRIGGERS = ['evidence_derived_needs_source', 'proposal_evidence_exists',
  'proposal_needs_direct_evidence', 'proposal_ticket_vs_evidence', 'validation_binds_proposal',
  'publication_requires_passed_validation', 'publication_restores_target', 'publication_live_needs_owner_ref',
  'publication_single_live']

export const RECORD_KINDS = ['evidence', 'proposal', 'validation', 'publication']

const RECORD_VIEWS = { evidence: evidenceView, proposal: proposalView, validation: validationView, publication: publicationView }

const GROUP_NAMES = { evidence: 'evidence', proposal: 'proposals', validation: 'validations', publication: 'publications' }

export const DEFAULT_PAGE_LIMIT = 50
export const MAX_PAGE_LIMIT = 200

/** The head-selecting statement per kind used by listByTicket, exported so a query-plan test cannot drift. */
export const TICKET_SQL = {
  evidence: `SELECT * FROM evidence WHERE ticket_id = ? AND subject_id = ? AND version = 1`,
  proposal: `SELECT * FROM proposal WHERE ticket_id = ? AND subject_id = ?
    AND version = (SELECT max(q.version) FROM proposal q WHERE q.id = proposal.id)`,
  validation: `SELECT * FROM validation WHERE ticket_id = ? AND subject_id = ?
    AND version = (SELECT max(q.version) FROM validation q WHERE q.id = validation.id)`,
  publication: `SELECT * FROM publication WHERE ticket_id = ? AND subject_id = ?
    AND version = (SELECT max(q.version) FROM publication q WHERE q.id = publication.id)`,
}

function pageOptions(options = {}) {
  const limit = Number.isInteger(options.limit) && options.limit > 0
    ? Math.min(options.limit, MAX_PAGE_LIMIT) : DEFAULT_PAGE_LIMIT
  const offset = Number.isInteger(options.offset) && options.offset > 0 ? options.offset : 0
  return { limit, offset }
}

/** A filter value must be one of the enum the table itself allows, or the query is a mistake. */
function assertFilterEnum(value, field, allowed) {
  if (value === undefined || value === null || value === '') return undefined
  const text = String(value)
  if (!allowed.includes(text)) {
    fail('EVOLUTION_INVALID_RECORD', `查询条件 ${field}=${JSON.stringify(text)} 不在枚举内`,
      `${field} 只能是：${allowed.join('、')}`)
  }
  return text
}

/** Open (creating if needed) the store; refuses to modify a file that is not ours. */
export async function openEvolutionStore(options = {}) {
  const env = options.env ?? process.env
  const paths = options.paths ?? resolveEvolutionPaths(env, options.home, { stateDir: options.stateDir, dbPath: options.dbPath })
  const subject = options.subject ?? await resolveSubject({ env, webServer: options.webServer ?? null })
  const sqlite = await loadSqliteModule({ importModule: options.importModule })

  prepareStateDir(paths.dir, 'Evolution 状态目录')
  const db = new sqlite.DatabaseSync(paths.file)
  try {
    claimOrAdopt(db, paths)
    db.exec('PRAGMA journal_mode=WAL')
    db.exec('PRAGMA synchronous=FULL')
    db.exec('PRAGMA foreign_keys=ON')
    db.exec('PRAGMA busy_timeout=2000')
    db.exec(SCHEMA_SQL)
    db.prepare(`INSERT INTO meta (key, value) VALUES ('schema_version', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(String(EVOLUTION_SCHEMA_VERSION))
    db.exec(`PRAGMA application_id = ${EVOLUTION_APPLICATION_ID}`)
    db.exec(`PRAGMA user_version = ${EVOLUTION_SCHEMA_VERSION}`)
  } catch (error) {
    db.close()
    throw fromSqlite(error)
  }
  protectFile(paths)
  return new EvolutionRecordStore({ db, paths, subject, now: options.now, limits: options.limits })
}

/** Read-only ownership and version gate, run before the first write of the session. */
function claimOrAdopt(db, paths) {
  const applicationId = Number(readPragma(db, 'application_id'))
  const userVersion = Number(readPragma(db, 'user_version'))
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all().map(row => row.name)
  if (applicationId !== 0 && applicationId !== EVOLUTION_APPLICATION_ID) {
    fail('EVOLUTION_STORE_FOREIGN', `${paths.file} 属于其他程序（application_id=${applicationId}）`,
      'Evolution 不会接管他人的库；请把 DSH_EVOLUTION_STATE_DIR 指向独立目录')
  }
  const foreign = tables.filter(name => !OUR_TABLES.includes(name))
  if (applicationId === 0 && foreign.length > 0) {
    fail('EVOLUTION_STORE_FOREIGN', `${paths.file} 已含非 Evolution 的表：${foreign.join('、')}`,
      '请换一个空目录给 DSH_EVOLUTION_STATE_DIR；Evolution 不会在别人的库里建表')
  }
  const stored = tables.includes('meta')
    ? Number(db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version')?.value ?? userVersion)
    : userVersion
  if (Number.isFinite(stored) && stored > 0 && userVersion > 0 && stored !== userVersion) {
    fail('EVOLUTION_STATE_CORRUPT', `${paths.file} 自相矛盾：meta.schema_version=${stored} 而 user_version=${userVersion}`,
      '请用 evolution.pre-migration-*.db 备份恢复，或人工把两者对齐到同一版本后重启')
  }
  const version = Number.isFinite(stored) && stored > 0 ? stored : userVersion
  if (version > EVOLUTION_SCHEMA_VERSION) {
    fail('EVOLUTION_SCHEMA_UNSUPPORTED', `${paths.file} 的记录结构版本 ${version} 新于本插件支持的 ${EVOLUTION_SCHEMA_VERSION}`,
      '请升级 dsh-evolution 后再打开；Evolution 不会降级改写已有记录')
  }
  if (version > 0 && version < MIN_SUPPORTED_SCHEMA) {
    fail('EVOLUTION_SCHEMA_UNSUPPORTED', `${paths.file} 的记录结构版本 ${version} 已不受支持`,
      `请先运行迁移（备份到 backups/evolution.pre-migration-v${version}-*.db，再升级到 ${EVOLUTION_SCHEMA_VERSION}）`)
  }
}

/** 0700 directory, 0600 database and sidecars — records carry provenance and operator identity. */
function protectFile(paths) {
  chmodSync(paths.file, 0o600)
  for (const sidecar of [`${paths.file}-wal`, `${paths.file}-shm`]) {
    if (existsSync(sidecar)) chmodSync(sidecar, 0o600)
  }
}

/**
 * The handle `apply()` hands to the HTTP layer: nothing is imported, created or opened
 * until the first request actually needs it (docs/architecture.md invariant #12).
 */
const LAZY_METHODS = ['summary', 'recordEvidence', 'upsertProposal', 'advanceProposal', 'recordValidation',
  'publish', 'rollback', 'publishKnowledge', 'rollbackKnowledge', 'getRecord', 'listByTicket', 'listEvidence',
  'listProposals', 'listValidations', 'listPublications', 'verifyHistory']

export function createLazyEvolutionStore(options = {}) {
  const env = options.env ?? process.env
  const paths = resolveEvolutionPaths(env, options.home, { stateDir: options.stateDir, dbPath: options.dbPath })
  let opened = null

  const ensure = async () => {
    if (opened) return opened
    const attempt = openEvolutionStore({ ...options, env, paths, home: options.home })
    try {
      opened = await attempt
    } catch (error) {
      opened = null
      throw error
    }
    return opened
  }

  const lazy = {
    paths,
    isOpen: () => opened !== null && opened.isOpen(),
    async close() {
      const store = opened
      opened = null
      if (store) await store.close()
    },
    async status() {
      try {
        return await (await ensure()).status()
      } catch (error) {
        const typed = fromSqlite(error)
        return { available: false, dir: paths.dir, file: paths.file, code: typed.code, error: typed.message, hint: typed.hint }
      }
    },
    async summarySafe() {
      if (!opened) {
        try {
          await ensure()
        } catch (error) {
          const typed = fromSqlite(error)
          return { available: false, code: typed.code, error: typed.message, hint: typed.hint }
        }
      }
      return opened.summarySafe()
    },
  }

  for (const name of LAZY_METHODS) {
    lazy[name] = async (...args) => (await ensure())[name](...args)
  }
  return lazy
}

