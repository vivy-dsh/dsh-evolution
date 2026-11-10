import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { DreamJournal, createDreamService, dreamGate, primaryEvidence, scanDreamEvidence, startDreamOnce, DREAM_DEFAULTS } from '../src/dream.mjs'

const subjectId = 'subject_12345678-1234-4234-8234-123456789012'
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
function events(id) {
  return [
    { seq: 0, type: 'turn/start', data: { turn: 1 } },
    { seq: 1, type: 'user/message', data: { id, source: { kind: 'user' }, content: [{ text: `fix ${id}` }] } },
    { seq: 2, type: 'tool/call', data: { turn: 1, callId: `call-${id}`, name: 'pwsh', arguments: '{"command":"node --test"}' } },
    { seq: 3, type: 'tool/result', data: { turn: 1, message: { toolCallId: `call-${id}`, content: 'test passed' } } },
    { seq: 4, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    { seq: 5, type: 'turn/start', data: { turn: 2 } },
    { seq: 6, type: 'user/message', data: { id: 'active', source: { kind: 'user' } } },
  ]
}
function fixture(t, { owner, count = 5 } = {}) {
  let home, submitted = [], active = true, subject = subjectId
  const logs = Object.fromEntries(Array.from({ length: count }, (_, i) => [`session-${i}`, events(String(i))]))
  const persistence = { identity: Symbol(), flush: async () => {}, open: async id => ({ inheritedEventCount: 0, read: async (offset = 0, length) => ({ events: logs[id].slice(offset, length === undefined ? undefined : offset + length) }), close: async () => {} }) }
  const ctx = { webServer: { port: 9999 }, get: name => name === 'sessionPersistence' ? persistence : name === 'workspaceRegistry' ? { list: () => [{ path: '/registered', sessionIds: Object.keys(logs) }] } : undefined }
  const fetchImpl = async (url, options) => ({ ok: true, json: async () => {
    if (url.endsWith('/subject')) return { subjectId: subject }
    if (url.endsWith('/inputs')) { submitted.push(JSON.parse(options.body)); return { triggerId: `trigger-${submitted.length}`, outcome: 'stored' } }
    return { state: active ? 'open' : 'ended', mandate: { scope: 'Refine source evidence', policyVersion: 'p1', basis: { scope: { subjectId } } }, assignments: [{ state: 'running' }], inputs: submitted.map((_, i) => ({ triggerId: `trigger-${i + 1}` })) }
  } })
  return mkdtemp(join(tmpdir(), 'dream-test-')).then(path => {
    home = path; t.after(() => rm(home, { recursive: true, force: true }))
    const service = createDreamService({ home, ctx, env: { DSH_SUBJECT_ID: subjectId }, fetchImpl, owner: owner ?? (async () => ({})) })
    return { home, service, logs, submitted, ctx, setActive: value => { active = value }, setSubject: value => { subject = value } }
  })
}
async function planned(f, candidates = []) {
  const request = await f.service.request({ mode: 'automatic' }), body = { requestId: request.id, ticketId: 'ticket-1' }
  await f.service.claim(body)
  const evidence = await f.service.evidence(body)
  const factCards = evidence.sessions.map(session => ({ sessionId: session.sessionId, insight: 'Verified source result', refs: session.facts.map(fact => fact.ref.id) }))
  const coverage = factCards.flatMap(card => card.refs)
  const plan = { factCards, coverage, candidates: candidates.map(candidate => ({ ...candidate, refs: candidate.refs ?? coverage })) }
  await f.service.plan({ ...body, plan })
  return { body, plan, request }
}

test('primary source gate excludes open turns, synthetic messages, inherited/fork and generated sessions', () => {
  const log = events('one')
  log.splice(2, 0, { seq: 1.5, type: 'user/message', data: { source: { kind: 'dsh-superagent' } } })
  assert.equal(primaryEvidence({ sessionId: 's', events: log }).length, 2)
  assert.equal(primaryEvidence({ sessionId: 'worker-x', events: log }).length, 0)
  assert.equal(primaryEvidence({ sessionId: 's', events: log, inheritedEventCount: 4 }).length, 0)
  log.find(event => event.type === 'tool/call').data.name = 'subagent'
  assert.equal(primaryEvidence({ sessionId: 's', events: log }).length, 1)
})

test('both thresholds and completed cooldown are required, attempts never count as completion', () => {
  const state = { config: DREAM_DEFAULTS, consumed: [], lastAttemptAt: new Date().toISOString() }
  const refs = Array.from({ length: 10 }, (_, i) => ({ id: i, sessionId: `s${i % 5}` }))
  assert.equal(dreamGate(state, { refs }).eligible, true)
  assert.equal(dreamGate(state, { refs: refs.slice(0, 9) }).reason, 'insufficient_evidence')
  state.lastCompletedAt = new Date().toISOString()
  assert.equal(dreamGate(state, { refs }).reason, 'cooldown')
})

test('config refuses fractional material thresholds and preserves committed settings after refusal', async t => {
  const f = await fixture(t)
  await assert.rejects(f.service.config({ minSessions: 1.5 }), /Invalid Dream setting/)
  await assert.rejects(f.service.config({ minPrimaryEvents: 1.5 }), /Invalid Dream setting/)
  assert.equal((await f.service.status()).config.minSessions, 5)
})

test('scan uses only registered source storage and deduplicates primary event identity', async t => {
  const f = await fixture(t)
  f.logs['session-duplicate'] = f.logs['session-0']
  f.logs['worker-evaluation'] = events('generated')
  const result = await scanDreamEvidence(f.ctx)
  assert.equal(result.refs.length, 10)
  assert.equal(result.refs.some(ref => ref.sessionId.startsWith('worker-')), false)
})

test('startup submits a nonhuman ordinary Input with normal shell CLI and no direct acceptance', async t => {
  const f = await fixture(t)
  const request = await f.service.startup()
  assert.equal(request.status, 'submitted')
  assert.equal(f.submitted[0].human, false)
  assert.equal(f.submitted[0].layer, 'evolution')
  assert.match(f.submitted[0].payload.text, /dream_refine tool/)
  await f.service.startup()
  assert.equal(f.submitted.length, 1)
  assert.equal((await f.service.status()).lastCompletedAt, undefined)
})

test('manual current-session requests bypass counts, never source ownership or actual Ticket authorization', async t => {
  const f = await fixture(t, { count: 1 })
  assert.equal((await f.service.startup()).reason, 'insufficient_sessions')
  await assert.rejects(f.service.request({ mode: 'manual' }), /current sessionId/)
  const request = await f.service.request({ sessionId: 'session-0' })
  assert.equal(request.snapshot.sessions.length, 1)
  f.setActive(false)
  await assert.rejects(f.service.claim({ requestId: request.id, ticketId: 'ticket-1' }), /live Ticket/)
  f.setActive(true); f.setSubject('another-subject')
  await assert.rejects(f.service.claim({ requestId: request.id, ticketId: 'ticket-1' }), /subject mismatch/)
})

test('frozen evidence reads reject source mutation; newly appended events are deferred', async t => {
  const f = await fixture(t), request = await f.service.startup(), body = { requestId: request.id, ticketId: 'ticket-1' }
  await f.service.claim(body)
  f.logs['session-0'].push({ seq: 7, type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
  assert.equal((await f.service.evidence(body)).sessions[0].facts.length, 2)
  f.logs['session-0'][1].data.content = 'rewritten'
  await assert.rejects(f.service.evidence(body), /digest mismatch/)
})

test('analyzed no-op completion consumes covered facts and prevents terminal plan mutation', async t => {
  const f = await fixture(t), { body, plan } = await planned(f)
  const result = await f.service.execute(body)
  assert.equal(result.phase, 'completed')
  assert.equal((await f.service.status()).consumed.length, 10)
  await assert.rejects(f.service.plan({ ...body, plan }), /immutable/)
  assert.equal((await f.service.startup()).reason, 'cooldown')
})

test('owner staging holds candidate bodies; completion leaves the candidate for human review and never publishes', async t => {
  let staged = 0, calls = []
  const f = await fixture(t, { owner: async (name, path, body) => {
    calls.push(path)
    if (path === '/candidates') { staged++; return { candidateId: 'c1', bundleDigest: 'bundle', baselineDigest: null, entry: { content: 'SECRET-OWNER-BODY' } } }
    return {}
  } })
  const { body, plan } = await planned(f, [{ kind: 'skill', skillId: 'test-skill', expectedDigest: null, entry: { content: 'SECRET-OWNER-BODY' } }])
  const manifest = await readFile(join(f.home, 'evolution', 'dream', subjectId, 'manifest.json'), 'utf8')
  assert.equal(manifest.includes('SECRET-OWNER-BODY'), false)
  const result = await f.service.execute(body)
  // Nothing is validated or published on this path; the run only hands control to the panel.
  assert.equal(result.phase, 'completed')
  assert.equal(result.candidates[0].status, 'pending_review')
  assert.equal(calls.filter(path => path === '/validate' || path === '/publish').length, 0)
  assert.equal(staged, 1)
  const [a, b] = await Promise.all([f.service.execute(body), f.service.execute(body)])
  assert.equal(a.phase, 'completed'); assert.equal(b.phase, 'completed')
  assert.equal(staged, 1)
  await assert.rejects(f.service.authorize({ ...body, subjectId, scope: 'skill:stage', skillId: 'test-skill', entryDigest: hash(plan.candidates[0].entry) }), /settled|absent/)
})

test('a skill publication recorded by the owner panel shows up on the run without touching the journal', async t => {
  const f = await fixture(t, { owner: async (name, path, body) => {
    if (path === '/candidates') return { candidateId: 'c1', skillId: 'test-skill', bundleDigest: 'bundle', baselineDigest: null }
    if (path === '/status' && body?.idempotencyKey === undefined) return []
    return {}
  } })
  const { body } = await planned(f, [{ kind: 'skill', skillId: 'test-skill', expectedDigest: null, entry: { content: 'instructions' } }])
  await f.service.execute(body)
  const before = await f.service.status()
  assert.equal(before.runs[0].candidates[0].status, 'pending_review')
  assert.equal(before.runs[0].candidates[0].publication, undefined)
  // The human approved it in the panel: the owner now reports it live.
  const live = await fixture(t, { owner: async (name, path) => path === '/status' ? [{ skillId: 'test-skill', bundleDigest: 'bundle', publicationId: 'pub1', version: 1, decisionDigest: 'd1' }] : { candidateId: 'c1', skillId: 'test-skill', bundleDigest: 'bundle', baselineDigest: null } })
  const published = await planned(live, [{ kind: 'skill', skillId: 'test-skill', expectedDigest: null, entry: { content: 'instructions' } }])
  await live.service.execute(published.body)
  const after = await live.service.status()
  assert.equal(after.runs[0].candidates[0].status, 'published')
  assert.deepEqual(after.runs[0].candidates[0].publication, { publicationId: 'pub1', version: 1, decisionDigest: 'd1' })
})

test('exact skill entry digest and staged owner candidate bind authorization; journal excludes arbitrary model fields', async t => {
  const f = await fixture(t, { owner: async () => ({ candidateId: 'c1', bundleDigest: 'bundle', entry: { content: 'OWNER-SECRET' } }) })
  const { body, plan } = await planned(f, [{ kind: 'skill', skillId: 'test-skill', expectedDigest: null, entry: { content: 'OWNER-SECRET' }, arbitrary: 'ARBITRARY-SECRET' }])
  const state = await f.service.status(), entryDigest = state.runs[0].plan.candidates[0].entryDigest
  const skillAuth = { ...body, scope: 'skill:stage', skillId: 'test-skill', entryDigest, expectedDigest: null, evidenceRefs: state.requests[0].snapshot.refs }
  assert.equal((await f.service.authorize(skillAuth)).authorized, true)
  await assert.rejects(f.service.authorize({ ...skillAuth, expectedDigest: 'f'.repeat(64) }), /Exact skill/)
  await assert.rejects(f.service.authorize({ ...skillAuth, evidenceRefs: [{ ...skillAuth.evidenceRefs[0], digest: 'forged' }, ...skillAuth.evidenceRefs.slice(1)] }), /provenance/)
  await assert.rejects(f.service.authorize({ ...skillAuth, evidenceRefs: skillAuth.evidenceRefs.map(ref => ({ ...ref, workspace: '/forged' })) }), /provenance/)
  await assert.rejects(f.service.authorize({ ...body, scope: 'skill:stage', skillId: 'test-skill', entryDigest: 'forged' }), /Exact skill/)
  await assert.rejects(f.service.authorize({ ...skillAuth, scope: 'skill:publish', candidateId: 'other', bundleDigest: 'bundle' }), /human in the owner panel/)
  const manifest = await readFile(join(f.home, 'evolution', 'dream', subjectId, 'manifest.json'), 'utf8')
  assert.equal(manifest.includes('OWNER-SECRET'), false); assert.equal(manifest.includes('ARBITRARY-SECRET'), false)
  assert.ok(plan.candidates.length)
})

test('persona and skill candidates both settle into review without any owner publication call', async t => {
  const f = await fixture(t, { owner: async (name, path) => path.includes('candidates') ? { candidateId: `${name}-candidate`, bundleDigest: 'bundle', baselineDigest: null } : [] })
  const request = await f.service.startup(), body = { requestId: request.id, ticketId: 'ticket-1' }
  await f.service.claim(body); const evidence = await f.service.evidence(body)
  const refs = evidence.sessions.flatMap(s => s.facts.map(fact => fact.ref.id))
  await f.service.plan({ ...body, plan: { factCards: evidence.sessions.map(s => ({ sessionId: s.sessionId, refs: s.facts.map(f => f.ref.id) })), coverage: refs, candidates: [
    { kind: 'persona', summary: 'Source-grounded insight', files: { 'SOUL.md': 'insight' }, expectedBaseRevision: 0, expectedDraftDigest: 'digest', refs: refs.slice(0, 2) },
    { kind: 'skill', skillId: 'skill', entry: { content: 'instructions' }, expectedDigest: null, refs: refs.slice(2) },
  ] } })
  const personaAuth = { ...body, subjectId, scope: 'persona:stage', filesDigest: hash({ 'SOUL.md': 'insight' }), expectedBaseRevision: 0, expectedDraftDigest: 'digest', summary: 'Source-grounded insight', evidenceIds: refs.slice(0, 2) }
  assert.equal((await f.service.authorize(personaAuth)).authorized, true)
  await assert.rejects(f.service.authorize({ ...personaAuth, expectedDraftDigest: 'other' }), /Exact persona/)
  const result = await f.service.execute(body)
  assert.equal(result.phase, 'completed')
  assert.deepEqual(result.candidates.map(candidate => candidate.status), ['pending_review', 'pending_review'])
  const status = await f.service.status()
  assert.equal(status.consumed.length, refs.length)
  assert.ok(status.lastCompletedAt)
})

test('manifest serializes concurrent writes and survives reopening', async t => {
  const home = await mkdtemp(join(tmpdir(), 'dream-journal-')); t.after(() => rm(home, { recursive: true, force: true }))
  const a = new DreamJournal(home, subjectId), b = new DreamJournal(home, subjectId)
  await Promise.all(Array.from({ length: 8 }, (_, i) => (i % 2 ? a : b).update(state => { state.count = (state.count ?? 0) + 1; return null })))
  assert.equal((await new DreamJournal(home, subjectId).read()).count, 8)
})

test('ready startup hook checks once per real persistence identity across plugin reload', async () => {
  let callback, launches = 0, committed = false
  const persistence = { identity: Symbol() }, appReady = { onReady: fn => { callback = fn; if (committed) fn(); return () => {} } }
  const ctx = { get: name => name === 'appReady' ? appReady : name === 'sessionPersistence' ? persistence : undefined }
  startDreamOnce(ctx, { startup: async () => { launches++ } })
  assert.equal(launches, 0)
  committed = true; callback()
  startDreamOnce(ctx, { startup: async () => { launches++ } }); callback()
  await Promise.resolve(); assert.equal(launches, 1)
})
