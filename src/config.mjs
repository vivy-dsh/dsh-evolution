/** Projection and write whitelist for the continual-harness profile entry. */
import { join, resolve } from 'node:path'
import { HARNESS_ENTRY_ID, EvolutionError, jsonClone } from './harness.mjs'

/**
 * Curated config fields: the panel form, the write whitelist, and the only
 * paths this plugin will ever place in the profile patch.
 */
export const CONFIG_FIELDS = [
  { path: ['requireGlobalApproval'], label: '全局变更需人工确认', group: '自动进化', type: 'switch' },
  { path: ['defaultGlobal'], label: '默认写入全局', group: '注入与治理', type: 'switch', hint: '调用未指定 global 时使用的 store' },
  { path: ['maxInjectedEntriesPerKind'], label: '每类注入上限', group: '注入与治理', type: 'number', min: 1, step: 1 },
  {
    path: ['injectionAnchor'], label: '注入锚点', group: '注入与治理', type: 'select',
    options: [{ value: 'stable', label: '稳定锚点（默认，保留 prefix 缓存）' }, { value: 'query', label: '跟随当前问题' }],
    hint: '稳定锚点减少 prefix 失效；跟随问题更贴近当前话题',
  },
  {
    path: ['protectedKinds'], label: '自动路径保护类型', group: '注入与治理', type: 'multi',
    options: [{ value: 'prompt', label: 'prompt' }, { value: 'memory', label: 'memory' }, { value: 'skill', label: 'skill' }, { value: 'subagent', label: 'subagent' }],
    hint: '自动路径不得修改这些类型',
  },
  { path: ['wrapupEnabled'], label: '注册 harness_wrapup', group: '生命周期', type: 'switch' },
  { path: ['benchmark', 'enabled'], label: '启用基准工具', group: '基准', type: 'switch' },
  { path: ['benchmark', 'defaultRuns'], label: '默认每侧轮数', group: '基准', type: 'number', min: 1, step: 1 },
  { path: ['benchmark', 'maxRuns'], label: '最大轮数', group: '基准', type: 'number', min: 1, step: 1 },
  { path: ['benchmark', 'passThreshold'], label: '通过线（0-100）', group: '基准', type: 'number', min: 0, max: 100, step: 1, hint: '仅作报告，不用于自动回滚' },
  { path: ['benchmark', 'regressionTolerance'], label: '回归容忍度', group: '基准', type: 'number', min: 0, step: 0.01 },
  { path: ['benchmark', 'maxFailedCells'], label: '允许失败单元格', group: '基准', type: 'number', min: 0, step: 1 },
  { path: ['diagnosticsEnabled'], label: '提交后运行诊断', group: '诊断与日志', type: 'switch' },
  { path: ['securityEnabled'], label: '启用本地 L3 安全提供者', group: '诊断与日志', type: 'switch' },
  { path: ['logToFile'], label: '写入持续进化日志', group: '诊断与日志', type: 'switch' },
  { path: ['logMaxBytes'], label: '日志大小上限（字节）', group: '诊断与日志', type: 'number', min: 1, step: 1 },
]

const FIELD_INDEX = new Map(CONFIG_FIELDS.map(field => [field.path.join('.'), field]))

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function invalid(message) {
  throw new EvolutionError('INVALID_FIELD', message, '只提交设置页展示的字段')
}

function checkValue(field, value, label) {
  if (field.type === 'switch') {
    if (typeof value !== 'boolean') invalid(`${label} 必须是布尔值`)
    return
  }
  if (field.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) invalid(`${label} 必须是有限数字`)
    if (field.min !== undefined && value < field.min) invalid(`${label} 不能小于 ${field.min}`)
    if (field.max !== undefined && value > field.max) invalid(`${label} 不能大于 ${field.max}`)
    if (field.step === 1 && !Number.isInteger(value)) invalid(`${label} 必须是整数`)
    return
  }
  if (field.type === 'select') {
    if (!field.options?.some(option => option.value === value)) invalid(`${label} 的取值不合法`)
    return
  }
  if (field.type === 'multi') {
    if (!Array.isArray(value) || value.some(item => !field.options?.some(option => option.value === item))) {
      invalid(`${label} 的取值不合法`)
    }
    return
  }
  invalid(`${label} 不受支持`)
}

/** Reject any write path outside {@link CONFIG_FIELDS} before it reaches the profile patch. */
export function assertAllowedPatch(patch) {
  if (!isPlainObject(patch)) invalid('配置补丁必须是对象')
  const walk = (node, path) => {
    const field = FIELD_INDEX.get(path.join('.'))
    if (field) {
      checkValue(field, node, field.label)
      return
    }
    if (!isPlainObject(node)) invalid(`不允许修改 ${path.join('.') || '(root)'}`)
    const children = Object.entries(node).filter(([, child]) => child !== undefined)
    if (children.length === 0) return
    for (const [key, child] of children) walk(child, [...path, key])
  }
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) walk(value, [key])
  }
}

/** Merge a patch into raw config: objects merge recursively, arrays replace wholesale. */
export function mergePatch(current, patch) {
  if (!isPlainObject(current) || !isPlainObject(patch)) return jsonClone(patch)
  const next = { ...current }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    next[key] = isPlainObject(next[key]) && isPlainObject(value) ? mergePatch(next[key], value) : jsonClone(value)
  }
  return next
}

function requireEntry(ctx) {
  const entry = ctx.configEditor.entries().find(item => item.options.id === HARNESS_ENTRY_ID)
  if (!entry) {
    throw new EvolutionError('EVOLUTION_UNAVAILABLE', '找不到 continual-harness 配置条目', '先在插件页启用 continual-harness')
  }
  if (entry.fiber === undefined) {
    throw new EvolutionError('EVOLUTION_UNAVAILABLE', 'continual-harness 未启用，无法写入配置', '先在插件页启用 continual-harness')
  }
  return entry
}

function safeConfig(value) {
  try { return jsonClone(value ?? {}) } catch { return {} }
}

function resolveDir(value, fallback) {
  return typeof value === 'string' && value ? resolve(value) : fallback
}

/** Read effective, inherited, and profile-override config for the settings form. */
export function readConfig(ctx, dshHome) {
  const documentPath = ctx.configEditor.documentPath
  const row = ctx.configEditor.configuration().find(item => item.entry.options.id === HARNESS_ENTRY_ID) ?? null
  if (!row) {
    return {
      available: false,
      active: false,
      documentPath,
      values: {},
      override: {},
      inherited: {},
      harnessRoot: join(dshHome, 'harness'),
      skillsDir: join(dshHome, 'skills'),
      fields: CONFIG_FIELDS,
    }
  }
  const values = safeConfig(row.entry.fiber?.config ?? row.entry.options.config)
  return {
    available: true,
    active: Boolean(row.entry.fiber),
    documentPath,
    values,
    override: safeConfig(row.override),
    inherited: safeConfig(row.inherited),
    harnessRoot: resolveDir(values.harnessRoot, join(dshHome, 'harness')),
    skillsDir: resolveDir(values.skillsDir, join(dshHome, 'skills')),
    fields: CONFIG_FIELDS,
  }
}

/** Persist the changed fields through the profile config editor, which validates and reloads the entry. */
export async function applyConfig(ctx, patch) {
  assertAllowedPatch(patch)
  const entry = requireEntry(ctx)
  await ctx.configEditor.edit(entry, current => mergePatch(current ?? {}, patch))
}

/** Remove the profile override so the entry falls back to inherited defaults. */
export async function resetConfig(ctx) {
  const entry = requireEntry(ctx)
  await ctx.configEditor.edit(entry, (_current, inherited) => safeConfig(inherited))
}
