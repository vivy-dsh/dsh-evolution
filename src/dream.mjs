/** AutoDream domain state. Superagent owns admission, execution and retries. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, rename, rm, open } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { resolveSubject } from '../../_shared/subject.mjs'
import { callComponent } from '../../_shared/ipc.mjs'

export const DREAM_DEFAULTS = Object.freeze({ enabled: true, cooldownHours: 24, minSessions: 5, minPrimaryEvents: 10 })
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
// Must match the SkillOwner's assetDigest wire contract.
const assetDigest = value => {
  const canonical = v => Array.isArray(v) ? v.map(canonical) : v !== null && typeof v === 'object'
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, canonical(x)])) : v
  return hash(canonical(value))
}
const clone = value => structuredClone(value)
function refuse(message, code = 'EVOLUTION_DREAM_REFUSED') { throw Object.assign(new Error(message), { code }) }
const terminal = run => ['completed', 'completed_rejected'].includes(run.phase)
const writes = new Map()

/** Atomic, installation/subject-scoped manifest, with an OS-process lock. No model or asset bodies in this journal. */
export class DreamJournal {
  constructor(home, subjectId) { this.dir = join(home, 'evolution', 'dream', subjectId); this.file = join(this.dir, 'manifest.json') }
  async read() {
    try {
      const value = JSON.parse(await readFile(this.file, 'utf8'))
      if (value.version !== 1) refuse('Unsupported Dream manifest version')
      return value
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      return { version: 1, config: { ...DREAM_DEFAULTS }, consumed: [], requests: [], runs: [] }
    }
  }
  async update(change) {
    const previous = writes.get(this.file) ?? Promise.resolve()
    const pending = previous.catch(() => {}).then(() => this.updateLocked(change))
    writes.set(this.file, pending)
    try { return await pending } finally { if (writes.get(this.file) === pending) writes.delete(this.file) }
  }
  async updateLocked(change) {
    await mkdir(this.dir, { recursive: true })
    const lock = join(this.dir, 'manifest.lock')
    let owned = false
    for (let attempt = 0; attempt < 100; attempt++) {
      try { await mkdir(lock); owned = true; await writeFile(join(lock, 'pid'), String(process.pid)); break }
      catch (error) {
        // Windows can report a just-removed directory as EPERM until its handle closes.
        if (!['EEXIST', 'EPERM'].includes(error.code)) throw error
        try {
          const pid = Number(await readFile(join(lock, 'pid'), 'utf8'))
          if (pid > 0) { try { process.kill(pid, 0) } catch (dead) { if (dead.code === 'ESRCH') { await rm(lock, { recursive: true, force: true }); continue } } }
        } catch { /* a live owner may still be creating its pid file */ }
        await new Promise(done => setTimeout(done, 20))
      }
    }
    if (!owned) refuse('Dream journal is busy', 'EVOLUTION_CONFLICT')
    try {
      const value = await this.read(), result = await change(value)
      const temporary = `${this.file}.${randomUUID()}.tmp`
      const handle = await open(temporary, 'wx')
      try { await handle.writeFile(JSON.stringify(value)); await handle.sync() } finally { await handle.close() }
      await rename(temporary, this.file)
      return clone(result)
    } finally { await rm(lock, { recursive: true, force: true }) }
  }
}

/** Only original human messages and tool receipts inside completed source turns count. */
export function primaryEvidence({ sessionId, workspace, events, inheritedEventCount = 0 }) {
  if (/^(?:worker-|orchestrator-|dream-|eval-)/.test(sessionId)) return []
  const completed = new Set(events.filter(e => e.type === 'turn/end' && e.data?.reason?.kind === 'completed').map(e => e.data.turn))
  const calls = new Map(events.filter(event => event.type === 'tool/call').map(event => [event.data.callId, event.data]))
  let turn
  const refs = []
  for (const event of events) {
    if (event.type === 'turn/start') turn = event.data.turn
    if (event.seq < inheritedEventCount || !completed.has(event.data?.turn ?? turn)) continue
    if (event.type !== 'tool/result' && !(event.type === 'user/message' && event.data?.source?.kind === 'user')) continue
    const call = event.type === 'tool/result' ? calls.get(event.data?.message?.toolCallId) : undefined
    if (event.type === 'tool/result' && (!call || /^(?:skill$|todo_|subagent$|send_message$|list_agents$|interrupt_agent$|orchestrator_|harness_|dream_)/.test(call.name))) continue
    // The source object excludes seq/time so inherited/re-emitted duplicate messages deduplicate.
    const digest = hash({ type: event.type, data: event.data, ...(call ? { call: { name: call.name, arguments: call.arguments } } : {}) })
    refs.push({ id: `event:${digest}`, sessionId, workspace, seq: event.seq, digest, type: event.type, ...(call ? { toolName: call.name } : {}), time: event.time })
  }
  return refs
}

/** Use source-owned persistence and registered Workspace membership, never guessed on-disk paths. */
export async function scanDreamEvidence(ctx, { sessionId, crossSession = true } = {}) {
  const registry = ctx.get('workspaceRegistry'), persistence = ctx.get('sessionPersistence')
  if (!registry || !persistence) refuse('Workspace registry or Session persistence unavailable')
  await persistence.flush()
  const seen = new Set(), sessions = [], refs = []
  for (const workspace of registry.list()) {
    for (const raw of workspace.sessionIds) {
      const id = String(raw)
      if (seen.has(id) || (!crossSession && id !== sessionId)) continue
      seen.add(id)
      if (/^(?:worker-|orchestrator-|dream-|eval-)/.test(id)) continue
      const handle = await persistence.open(id, 'read')
      try {
        // One read fixes the immutable upper bound. Newly appended events are deferred.
        const { events } = await handle.read()
        const primary = primaryEvidence({ sessionId: id, workspace: workspace.path, events, inheritedEventCount: handle.inheritedEventCount })
        if (!primary.length) continue
        sessions.push({ sessionId: id, workspace: workspace.path, upperBound: events.length, digest: hash(events), inheritedEventCount: handle.inheritedEventCount })
        refs.push(...primary)
      } finally { await handle.close() }
    }
  }
  return { sessions, refs: [...new Map(refs.map(ref => [ref.id, ref])).values()] }
}

export function dreamGate(state, snapshot, now = Date.now()) {
  const consumed = new Set(state.consumed), refs = snapshot.refs.filter(ref => !consumed.has(ref.id))
  const sessionCount = new Set(refs.map(ref => ref.sessionId)).size, primaryEventCount = refs.length
  let reason = 'eligible'
  if (!state.config.enabled) reason = 'disabled'
  else if (state.lastCompletedAt && now - Date.parse(state.lastCompletedAt) < state.config.cooldownHours * 3600000) reason = 'cooldown'
  else if (sessionCount < state.config.minSessions) reason = 'insufficient_sessions'
  else if (primaryEventCount < state.config.minPrimaryEvents) reason = 'insufficient_evidence'
  return { at: new Date(now).toISOString(), eligible: reason === 'eligible', reason, sessionCount, primaryEventCount }
}

export function createDreamService({ home, ctx, env = process.env, now = () => Date.now(), fetchImpl = fetch, scan = options => scanDreamEvidence(ctx, options), owner = (name, path, body) => callComponent({ home, name, path, body }) }) {
  let journal, subjectId
  const operations = new Map()
  async function serialized(key, operation) {
    const previous = operations.get(key) ?? Promise.resolve()
    const pending = previous.catch(() => {}).then(operation)
    operations.set(key, pending)
    try { return await pending } finally { if (operations.get(key) === pending) operations.delete(key) }
  }
  const ready = async () => { subjectId ??= await resolveSubject({ env, webServer: ctx.webServer, fetchImpl }); journal ??= new DreamJournal(home, subjectId); return journal }
  const api = async (path, body) => {
    const response = await fetchImpl(`http://127.0.0.1:${ctx.webServer.port}/orchestrator/api/${path}`, {
      method: body === undefined ? 'GET' : 'POST', headers: { 'x-orchestrator-request': '1', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000),
    })
    if (!response.ok) refuse(`Superagent ${path} returned HTTP ${response.status}`)
    return response.json()
  }
  const timestamp = () => new Date(now()).toISOString()
  async function status() {
    await ready()
    const state = await journal.read()
    // The journal records the request; the owner records what a human approved.
    // Merge the live publications so a run stops looking unresolved once the
    // panel has promoted its candidate.
    let publications = []
    try { const live = await owner('harness', '/status', {}); publications = Array.isArray(live) ? live : [] } catch { publications = [] }
    const runs = state.runs.map(run => ({
      ...run,
      candidates: (run.candidates ?? []).map(candidate => {
        const published = candidate.ownerRef?.skillId ? publications.find(item => item.skillId === candidate.ownerRef.skillId) : undefined
        if (!published || published.bundleDigest !== candidate.ownerRef?.bundleDigest) return candidate
        return { ...candidate, status: 'published', publication: { publicationId: published.publicationId, version: published.version, decisionDigest: published.decisionDigest } }
      }),
    }))
    return { ok: true, subjectId, ...state, runs }
  }
  async function config(patch) {
    await ready()
    return journal.update(state => {
      for (const [key, value] of Object.entries(patch ?? {})) {
        if (!(key in DREAM_DEFAULTS)) refuse(`Unknown Dream setting ${key}`)
        if (key === 'enabled' ? typeof value !== 'boolean' : !Number.isFinite(value) || value < 1 || value > (key === 'cooldownHours' ? 8760 : 100000) || (key !== 'cooldownHours' && !Number.isInteger(value))) refuse(`Invalid Dream setting ${key}`)
        state.config[key] = value
      }
      return { ok: true, config: state.config }
    })
  }
  async function request({ mode = 'manual', sessionId, crossSession = false, instructions = '' } = {}) {
    if (!['automatic', 'manual'].includes(mode)) refuse('Invalid Dream mode')
    if (typeof instructions !== 'string' || instructions.length > 8000) refuse('Refine instructions must be text up to 8000 characters')
    if (mode === 'manual' && !crossSession && !sessionId) refuse('Manual refine requires current sessionId or explicit crossSession')
    await ready()
    if (mode === 'automatic') {
      const early = dreamGate(await journal.read(), { refs: [] }, now())
      if (['disabled', 'cooldown'].includes(early.reason)) return journal.update(state => { state.lastCheck = early; return { skipped: true, reason: early.reason } })
    }
    const snapshot = await scan({ sessionId, crossSession: mode === 'automatic' || crossSession })
    const created = await journal.update(state => {
      const gate = dreamGate(state, snapshot, now()); state.lastCheck = gate
      if (mode === 'automatic' && !gate.eligible) return { skipped: true, reason: gate.reason }
      const consumed = new Set(state.consumed)
      snapshot.refs = snapshot.refs.filter(ref => !consumed.has(ref.id))
      snapshot.sessions = snapshot.sessions.filter(session => snapshot.refs.some(ref => ref.sessionId === session.sessionId))
      if (!snapshot.refs.length) return { skipped: true, reason: 'insufficient_evidence' }
      const snapshotDigest = hash(snapshot)
      const instructionsDigest = hash(instructions)
      const existing = state.requests.find(item => item.snapshotDigest === snapshotDigest && item.instructionsDigest === instructionsDigest && item.mode === mode && item.status !== 'filtered')
      if (existing) return existing
      const item = { id: `dream_${randomUUID()}`, mode, sessionId, crossSession, status: 'submitting', snapshotDigest, instructionsDigest, snapshot, createdAt: timestamp() }
      state.requests.push(item); state.lastAttemptAt = item.createdAt
      return item
    })
    if (created.skipped || created.status === 'submitted') return created
    const text = `Use the diva-dream skill. Refine source evidence request ${created.id}. This Ticket's Session has no shell or file tools: drive the run with the dream_refine tool (claim, evidence, baseline, plan, execute, status). Read the frozen material in pages, create per-session fact cards with immutable refs, synthesize across sessions, then submit the plan with dream_refine plan. Persona changes create user-review proposals; skill changes become owner candidates that a human approves in the panel. Report blocked infrastructure honestly. No self-evolution outside this request.${instructions ? `\nUser refine focus (does not change publication authority): ${instructions}` : ''}`
    const receipt = await api('inputs', { subjectId, sourceId: 'local', externalEventId: created.id, dedupeKey: created.id, layer: 'evolution', human: mode === 'manual', payload: { text }, provenance: { actor: mode === 'automatic' ? 'autodream' : 'manual-refine', note: `Frozen source snapshot ${created.snapshotDigest}` } })
    return journal.update(state => {
      const item = state.requests.find(item => item.id === created.id)
      item.inputId = receipt.triggerId; item.status = receipt.outcome === 'filtered' ? 'filtered' : 'submitted'; item.inputReceipt = receipt
      return item
    })
  }
  async function authorize({ ticketId, subjectId: requestedSubject, requestId, scope, skillId, entryDigest, expectedDigest, evidenceRefs, filesDigest, expectedBaseRevision, expectedDraftDigest, evidenceIds, summary } = {}) {
    await ready()
    if (requestedSubject && requestedSubject !== subjectId) refuse('Dream subject mismatch')
    if (!ticketId || !/^[a-zA-Z0-9_-]+$/.test(ticketId)) refuse('Ticket ID required')
    const state = await journal.read(), ticket = await api(`tickets/${encodeURIComponent(ticketId)}`)
    const liveSubject = await api('subject')
    if (liveSubject.subjectId !== subjectId || (ticket.subjectId && ticket.subjectId !== subjectId)) refuse('Live Ticket installation subject mismatch')
    const mandateSubject = ticket.mandate?.basis?.scope?.subjectId
    if (mandateSubject && mandateSubject !== subjectId) refuse('Ticket mandate subject mismatch')
    const item = state.requests.find(item => (!requestId || item.id === requestId) && item.inputId && ticket.inputs?.some(input => input.triggerId === item.inputId || input.trigger?.id === item.inputId))
    const assignment = ticket.assignments?.at(-1)
    if (!item || ticket.paused || !assignment || assignment.state !== 'running' || ticket.state !== 'open' || ticket.ended || !ticket.mandate?.scope || !ticket.mandate?.policyVersion) refuse('No live Ticket mandate/assignment owns this Dream Input')
    const run = state.runs.find(run => run.requestId === item.id)
    if (run && run.ticketId !== ticketId) refuse('Dream request already belongs to another Ticket')
    if (scope === 'skill:stage') {
      const index = run?.plan?.candidates.findIndex(candidate => candidate.kind === 'skill' && candidate.skillId === skillId && candidate.entryDigest === entryDigest && candidate.expectedDigest === expectedDigest)
      if (index === undefined || index < 0) refuse('Exact skill entry absent from frozen Dream plan')
      const plannedRefs = run.plan.candidates[index].refs.map(id => item.snapshot.refs.find(ref => ref.id === id))
      const canonicalRefs = refs => assetDigest([...refs].sort((a, b) => String(a?.id).localeCompare(String(b?.id))))
      if (!Array.isArray(evidenceRefs) || canonicalRefs(evidenceRefs) !== canonicalRefs(plannedRefs)) refuse('Skill evidence provenance does not match frozen source references')
      if (terminal(run)) refuse('Dream run already settled')
    } else if (scope?.startsWith('skill:')) refuse('Skill publication is decided by a human in the owner panel, not by this Ticket')
    if (scope === 'persona:stage') {
      const exact = run?.plan?.candidates.some(candidate => candidate.kind === 'persona' && candidate.filesDigest === filesDigest && candidate.expectedBaseRevision === expectedBaseRevision && candidate.expectedDraftDigest === expectedDraftDigest && candidate.summaryDigest === hash(summary ?? '') && hash([...new Set(candidate.refs)].sort()) === hash([...new Set(evidenceIds ?? [])].sort()))
      if (!exact || terminal(run)) refuse('Exact persona candidate absent from active frozen Dream plan')
    }
    return { authorized: true, requestId: item.id, runId: run?.id, subjectId }
  }
  async function claim(body) {
    const auth = await authorize(body)
    return journal.update(state => {
      let run = state.runs.find(run => run.requestId === auth.requestId)
      if (!run) { run = { id: `run_${randomUUID()}`, requestId: auth.requestId, ticketId: body.ticketId, phase: 'planning', coverage: [], candidates: [], createdAt: timestamp() }; state.runs.push(run) }
      return { run, request: state.requests.find(item => item.id === auth.requestId) }
    })
  }
  async function evidence(body) {
    const auth = await authorize(body), state = await journal.read(), item = state.requests.find(item => item.id === auth.requestId)
    const persistence = ctx.get('sessionPersistence'), result = []
    for (const source of item.snapshot.sessions) {
      const handle = await persistence.open(source.sessionId, 'read')
      try {
        const { events } = await handle.read(0, source.upperBound)
        if (hash(events) !== source.digest) refuse('Frozen source log digest mismatch')
        const refs = item.snapshot.refs.filter(ref => ref.sessionId === source.sessionId)
        result.push({ ...source, facts: refs.map(ref => {
          const event = events[ref.seq]
          const sourceCall = event.type === 'tool/result' ? events.find(candidate => candidate.type === 'tool/call' && candidate.data.callId === event.data.message.toolCallId) : undefined
          return { ref, event, ...(sourceCall ? { sourceCall } : {}) }
        }) })
      } finally { await handle.close() }
    }
    await journal.update(state => { const run = state.runs.find(run => run.requestId === item.id); if (!run) refuse('Claim run first'); run.snapshotReadAt = timestamp(); return null })
    return { requestId: item.id, snapshotDigest: item.snapshotDigest, sessions: result }
  }
  async function plan(body) {
    const auth = await authorize(body)
    const frozen = await journal.update(state => {
      const run = state.runs.find(run => run.requestId === auth.requestId)
      if (!run) refuse('Claim run first')
      if (terminal(run)) refuse('Completed Dream plans are immutable')
      if (!run.snapshotReadAt) refuse('Read the frozen evidence before planning')
      const item = state.requests.find(item => item.id === auth.requestId), known = new Set(item.snapshot.refs.map(ref => ref.id))
      const proposal = body.plan
      if (!proposal || !Array.isArray(proposal.coverage) || !proposal.coverage.length || !Array.isArray(proposal.candidates) || !Array.isArray(proposal.factCards)) refuse('Plan needs nonempty factCards/coverage and candidates')
      for (const card of proposal.factCards) if (!card.sessionId || !Array.isArray(card.refs) || !card.refs.length || card.refs.some(id => !known.has(id) || !item.snapshot.refs.some(ref => ref.id === id && ref.sessionId === card.sessionId))) refuse('Fact card needs source-session refs')
      const cardRefs = new Set(proposal.factCards.flatMap(card => card.refs))
      if (proposal.coverage.some(id => !known.has(id) || !cardRefs.has(id))) refuse('Coverage requires inspected fact cards')
      for (const candidate of proposal.candidates) {
        if (!['skill', 'persona'].includes(candidate.kind) || !Array.isArray(candidate.refs) || !candidate.refs.length || candidate.refs.some(id => !proposal.coverage.includes(id))) refuse('Candidate needs covered primary refs')
        if (candidate.kind === 'skill' && (!candidate.skillId || !candidate.entry || !(candidate.expectedDigest === null || typeof candidate.expectedDigest === 'string' && /^[a-f0-9]{64}$/.test(candidate.expectedDigest)))) refuse('Skill candidate needs entry and baseline digest')
        if (candidate.kind === 'persona' && (!candidate.files || !Number.isInteger(candidate.expectedBaseRevision) || !candidate.expectedDraftDigest || typeof candidate.summary !== 'string' || !candidate.summary.trim())) refuse('Persona candidate needs summary, files and baseline revision/digest')
      }
      const digest = hash(proposal)
      if (run.planDigest && run.planDigest !== digest) refuse('Plan is frozen; create another authorized request to change it')
      // Candidate bytes belong only to asset owners. The coordinator holds immutable refs/digests.
      if (new Set(proposal.candidates.filter(c => c.kind === 'skill').map(c => c.skillId)).size !== proposal.candidates.filter(c => c.kind === 'skill').length) refuse('A Dream plan may update each skill only once')
      run.plan = {
        factCards: proposal.factCards.map(card => ({ sessionId: card.sessionId, refs: card.refs, digest: hash(card) })),
        coverage: proposal.coverage,
        candidates: proposal.candidates.map(candidate => ({
          kind: candidate.kind, ...(candidate.skillId ? { skillId: candidate.skillId } : {}), refs: candidate.refs, candidateDigest: hash(candidate),
          ...(candidate.kind === 'skill' ? { entryDigest: assetDigest(candidate.entry), expectedDigest: candidate.expectedDigest } : {}),
          ...(candidate.kind === 'persona' ? { filesDigest: hash(Object.fromEntries(Object.keys(candidate.files).sort().map(key => [key, candidate.files[key]]))), expectedBaseRevision: candidate.expectedBaseRevision, expectedDraftDigest: candidate.expectedDraftDigest, summaryDigest: hash(candidate.summary ?? '') } : {}),
        })),
      }
      run.planDigest = digest; run.phase = 'staging'
      return run
    })
    const item = (await journal.read()).requests.find(item => item.id === auth.requestId)
    for (let index = 0; index < body.plan.candidates.length; index++) {
      const candidate = body.plan.candidates[index], key = `${frozen.id}:${index}`
      const prior = (await journal.read()).runs.find(run => run.id === frozen.id).candidates[index]
      if (prior?.ownerCandidateId) continue
      await authorize(body)
      try {
        // The owner re-authorizes against Evolution. Without the bound request id that
        // lookup falls back to "the first request this Ticket owns", so a Ticket with
        // an older Dream Input would authorize the wrong run and refuse this plan.
        const staged = candidate.kind === 'skill'
          ? await owner('harness', '/candidates', { ...candidate, subjectId, ticketId: frozen.ticketId, requestId: auth.requestId, evidenceRefs: candidate.refs.map(id => item.snapshot.refs.find(ref => ref.id === id)), idempotencyKey: key })
          : await owner('laputa', '/candidates/stage', { ...candidate, subjectId, ticketId: frozen.ticketId, requestId: auth.requestId, evidenceIds: candidate.refs, idempotencyKey: key })
        if (!staged?.candidateId) refuse('Owner did not return a candidate receipt')
        const ownerRef = Object.fromEntries(['candidateId', 'skillId', 'bundleDigest', 'baselineDigest', 'candidateDigest', 'personaId', 'baseRevision', 'status'].filter(key => staged[key] !== undefined).map(key => [key, staged[key]]))
        await updateRun(frozen.id, run => { run.candidates[index] = { kind: candidate.kind, refs: candidate.refs, status: 'staged', idempotencyKey: key, ownerCandidateId: staged.candidateId, ownerRef } })
      } catch (error) {
        await updateRun(frozen.id, run => { run.phase = 'blocked'; run.lastError = String(error.message ?? error) })
        throw error
      }
    }
    return updateRun(frozen.id, run => { run.phase = 'planned'; delete run.lastError })
  }
  async function updateRun(id, change) { return journal.update(state => { const run = state.runs.find(run => run.id === id); change(run, state); return run }) }
  async function execute(body) {
    const auth = await authorize(body)
    let state = await journal.read(), run = state.runs.find(run => run.requestId === auth.requestId)
    if (!run?.plan) refuse('Frozen plan required before execute')
    if (terminal(run)) return run
    await updateRun(run.id, r => { r.phase = 'awaiting_review' })
    for (let index = 0; index < run.plan.candidates.length; index++) {
      const candidate = run.plan.candidates[index], key = `${run.id}:${index}`
      let current = (await journal.read()).runs.find(r => r.id === run.id).candidates[index]
      if (current && ['published', 'pending_review', 'rejected'].includes(current.status)) continue
      await authorize(body)
      try {
        current ??= { kind: candidate.kind, refs: candidate.refs, status: 'staging', idempotencyKey: key }
        await updateRun(run.id, r => { r.candidates[index] = current })
        if (!current.ownerCandidateId) refuse('Candidate staging incomplete; retry the frozen plan')
        // Both kinds stop here: person changes and skill changes alike wait for
        // the human decision in its owner panel. Nothing is applied on this path.
        current.status = 'pending_review'
        delete current.error
      } catch (error) { current = { ...current, kind: candidate.kind, refs: candidate.refs, status: 'blocked', error: String(error.message ?? error) } }
      await updateRun(run.id, (r, s) => {
        r.candidates[index] = current
        if (['published', 'pending_review', 'rejected'].includes(current.status)) {
          r.coverage = [...new Set([...r.coverage, ...candidate.refs])]; s.consumed = [...new Set([...s.consumed, ...candidate.refs])]
          if (current.status === 'published') s.lastPublishedAt = timestamp()
        }
      })
    }
    return updateRun(run.id, (r, s) => {
      if (r.candidates.some(candidate => candidate.status === 'blocked')) { r.phase = 'blocked'; return }
      r.phase = r.candidates.length && r.candidates.every(candidate => candidate.status === 'rejected') ? 'completed_rejected' : 'completed'
      r.completedAt = timestamp(); s.lastCompletedAt = r.completedAt
      r.coverage = [...new Set([...r.coverage, ...r.plan.coverage])]; s.consumed = [...new Set([...s.consumed, ...r.coverage])]
    })
  }
  return { status, config, request, authorize, claim, evidence,
    plan: body => serialized(body.requestId, () => plan(body)), execute: body => serialized(body.requestId, () => execute(body)),
    // An empty body keeps this a POST: the Laputa internal channel only serves POST,
    // and a body-less callComponent would arrive as GET and be refused as unknown.
    baseline: async body => { await authorize(body); return { persona: await owner('laputa', '/baseline', {}), skills: await owner('harness', '/status', {}) } },
    startup: async () => {
      try { return await request({ mode: 'automatic', crossSession: true }) }
      catch (error) {
        if (journal) await journal.update(state => { state.lastCheck = { at: timestamp(), eligible: false, reason: 'startup_failed', error: String(error.message ?? error) }; return null })
        throw error
      }
    },
  }
}

// Persistence identity survives plugin reload but changes on actual runtime restart.
const started = globalThis[Symbol.for('diva.autodream.started')] ??= new Set()
export function startDreamOnce(ctx, dream) {
  const launch = () => {
    const identity = ctx.get('sessionPersistence')?.identity
    if (!identity || started.has(identity)) return
    started.add(identity)
    void dream.startup().catch(error => { ctx.logger?.warn?.(`AutoDream startup check: ${error.message}`) })
  }
  // DSH's Cordis fork does not emit a `ready` event. The launcher commits
  // appReady only after every profile row has finished mounting (including
  // Superagent's awaited runtime.ready). Its subscription also handles HMR.
  const ready = ctx.get('appReady')
  if (ready?.onReady) {
    const cancel = ready.onReady(launch)
    ctx.effect?.(() => cancel, 'autodream: application startup readiness')
  }
  return launch
}
