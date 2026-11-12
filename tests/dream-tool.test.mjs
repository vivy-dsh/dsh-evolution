import test from 'node:test'
import assert from 'node:assert/strict'
import { registerDreamTool } from '../src/dream-tool.mjs'

const at = Date.parse('2026-11-10T01:00:00.000Z')

function material() {
  return {
    requestId: 'dream_1',
    snapshotDigest: 'a'.repeat(64),
    sessions: [
      { sessionId: 'session-a', upperBound: 3, facts: [
        { ref: { id: 'event:1', sessionId: 'session-a', seq: 1 }, event: { time: at, type: 'user/message', data: { content: [{ text: 'fix the failing build' }] } } },
        { ref: { id: 'event:2', sessionId: 'session-a', seq: 2 }, event: { time: at + 1, type: 'tool/call', data: { name: 'pwsh', arguments: '{"command":"npm test"}' } } },
        { ref: { id: 'event:3', sessionId: 'session-a', seq: 3 }, event: { time: at + 2, type: 'tool/result', data: { message: { content: [{ type: 'text', text: 'all green' }] } } } },
      ] },
      { sessionId: 'session-b', upperBound: 1, facts: [
        { ref: { id: 'event:4', sessionId: 'session-b', seq: 0 }, event: { time: at + 3, type: 'user/message', data: { content: [{ text: 'ship it' }] } } },
      ] },
    ],
  }
}

function fixture() {
  const calls = []
  const dream = {
    claim: async body => { calls.push(['claim', body]); return { run: { id: 'run_1', phase: 'planning', candidates: [] }, request: { id: 'dream_1', mode: 'manual', snapshotDigest: 'a'.repeat(64), snapshot: { sessions: [{ sessionId: 'session-a', upperBound: 3 }, { sessionId: 'session-b', upperBound: 1 }], refs: [1, 2, 3, 4] } } } },
    evidence: async body => { calls.push(['evidence', body]); return material() },
    baseline: async body => { calls.push(['baseline', body]); return { persona: { revision: 3, digest: 'b'.repeat(64), draftDigest: 'd'.repeat(64) }, skills: { skills: [{ skillId: 'diva-dream', bundleDigest: 'c'.repeat(64), provider: 'skill' }] } } },
    plan: async body => { calls.push(['plan', body]); return { id: 'run_1', phase: 'planned', plan: { factCards: [1], coverage: [1, 2], candidates: [{ kind: 'persona' }] }, candidates: [{ kind: 'persona', status: 'staged' }] } },
    execute: async body => { calls.push(['execute', body]); return { id: 'run_1', phase: 'completed', candidates: [{ kind: 'persona', status: 'pending_review' }] } },
    status: async () => ({ runs: [{ id: 'run_1', requestId: 'dream_1', ticketId: 't1', phase: 'planned', candidates: [] }, { id: 'run_2', requestId: 'dream_2', ticketId: 't2', phase: 'done', candidates: [] }] }),
  }
  let definition
  const ctx = { tools: { register: registered => { definition = registered; return () => {} } }, effect: run => { run() } }
  registerDreamTool(ctx, { dream })
  return { dream, calls, tool: definition }
}

const worker = ticketId => ({ agent: { id: `worker-${ticketId}` } })

test('dream_refine refuses a Session that is not a Dream worker', async () => {
  const { tool } = fixture()
  await assert.rejects(tool.execute({ command: 'claim' }, { agent: { id: 'main' } }), /Dream refinement worker/)
  await assert.rejects(tool.execute({ command: 'claim' }, undefined), /Dream refinement worker/)
})

test('dream_refine binds every command to the worker ticket and keeps the claim result small', async () => {
  const { tool, calls } = fixture()
  const claimed = await tool.execute({ command: 'claim', request: 'dream_1' }, worker('t1'))
  assert.deepEqual(calls[0], ['claim', { ticketId: 't1', requestId: 'dream_1' }])
  assert.equal(claimed.request, 'dream_1')
  assert.equal(claimed.refs, 4)
  assert.deepEqual(claimed.sessions.map(session => session.sessionId), ['session-a', 'session-b'])
  assert.equal(JSON.stringify(claimed).includes('snapshot":'), false)
})

test('dream_refine pages evidence by session and reads one ref in full', async () => {
  const { tool, calls } = fixture()
  await assert.rejects(tool.execute({ command: 'evidence' }, worker('t1')), /Call claim first/)
  const claimed = await tool.execute({ command: 'claim' }, worker('t1'))
  assert.equal(claimed.request, 'dream_1')
  assert.deepEqual(calls.at(-1), ['claim', { ticketId: 't1' }])
  const list = await tool.execute({ command: 'evidence' }, worker('t1'))
  assert.deepEqual(calls.at(-1), ['evidence', { ticketId: 't1', requestId: 'dream_1' }])
  assert.deepEqual(list.sessions.map(session => [session.sessionId, session.refs]), [['session-a', 3], ['session-b', 1]])
  const page = await tool.execute({ command: 'evidence', session: 'session-a', limit: 2 }, worker('t1'))
  assert.equal(page.refs.length, 2)
  assert.equal(page.next.offset, 2)
  assert.match(page.refs[0], /event:1 .*user\/message :: fix the failing build/)
  assert.match(page.refs[1], /pwsh\(\{"command":"npm test"\}\)/)
  const rest = await tool.execute({ command: 'evidence', session: 'session-a', offset: 2 }, worker('t1'))
  assert.equal(rest.refs.length, 1)
  assert.equal(rest.next, null)
  const detail = await tool.execute({ command: 'evidence', ref: 'event:3' }, worker('t1'))
  assert.equal(detail.type, 'tool/result')
  assert.equal(detail.text, 'all green')
  await assert.rejects(tool.execute({ command: 'evidence', session: 'nope' }, worker('t1')), /Unknown session/)
  await assert.rejects(tool.execute({ command: 'evidence', ref: 'event:zzz' }, worker('t1')), /Unknown ref/)
})

test('dream_refine reads the baseline, submits a plan and stages nothing on its own', async () => {
  const { tool, calls } = fixture()
  await tool.execute({ command: 'claim' }, worker('t1'))
  const baseline = await tool.execute({ command: 'baseline' }, worker('t1'))
  assert.equal(baseline.persona.revision, 3)
  assert.equal(baseline.persona.draftDigest, 'd'.repeat(64))
  assert.deepEqual(baseline.skills, [{ id: 'diva-dream', digest: 'c'.repeat(64), provider: 'skill' }])
  await assert.rejects(tool.execute({ command: 'plan' }, worker('t1')), /plan object/)
  const plan = { coverage: ['event:1'], candidates: [], factCards: [] }
  const planned = await tool.execute({ command: 'plan', plan }, worker('t1'))
  assert.equal(calls.at(-1)[1].plan, plan)
  assert.deepEqual(planned.candidates, [{ kind: 'persona', status: 'staged' }])
  const executed = await tool.execute({ command: 'execute' }, worker('t1'))
  assert.equal(executed.phase, 'completed')
  assert.deepEqual(executed.candidates, [{ kind: 'persona', status: 'pending_review' }])
  assert.match(executed.note, /human decision/)
})

test('dream_refine status reports only the calling ticket run and refuses unknown commands', async () => {
  const { tool } = fixture()
  await tool.execute({ command: 'claim' }, worker('t1'))
  const status = await tool.execute({ command: 'status' }, worker('t1'))
  assert.equal(status.runId, 'run_1')
  await assert.rejects(tool.execute({ command: 'publish' }, worker('t1')), /Unknown command/)
})
