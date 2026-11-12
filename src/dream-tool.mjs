/**
 * The Dream executor's only tool. A Dream refinement synthesizes frozen evidence into reviewable
 * candidates instead of working in a repository, so it gets this tool and skills, no shell and no
 * file tools (see `patches/superagent-dream.patch`). Every call is bound to the worker Session's own
 * ticket: the request is resolved from the Ticket's mandate, never from an argument a model can forge.
 */

const COMMANDS = ['claim', 'evidence', 'baseline', 'plan', 'execute', 'status']
const DEFAULT_REFS = 30
const MAX_REFS = 80
const SNIPPET = 240
const DETAIL = 6000

const DESCRIPTION = `Read this Dream refinement's frozen source material and submit its plan. One tool for the whole run:
- claim: freeze the request; returns the snapshot size, not the material.
- evidence: with no session, lists the sessions and their ref counts; with session/offset/limit, returns that page
  of immutable refs; with ref, returns one event's full text. Read all of it before planning.
- baseline: the current persona revision and skill entries that a plan may change.
- plan: submits the plan object. Fact cards must cite refs from one session, coverage must be cited by a fact card,
  and a persona or skill candidate must cite covered refs. The plan is immutable once accepted.
- execute: stages the planned candidates for a human to approve or reject in the panel. It never publishes.
- status: this run's phase and per-candidate state.
Report honestly when the material cannot support a candidate; an empty refinement is valid.`

/** Text a stored session event shows a reader, bounded to `limit` characters. */
function textOf(event, limit) {
  const data = event?.data ?? {}
  const content = data.message?.content ?? data.content
  const parts = Array.isArray(content) ? content : typeof content === 'string' ? [{ text: content }] : []
  const text = parts.map(part => typeof part?.text === 'string' ? part.text
    : part?.type === 'toolCall' ? `${part.name ?? 'tool'}(${JSON.stringify(part.arguments ?? {})})`
      : '').filter(Boolean).join('\n')
  const rendered = text || (typeof data.name === 'string' ? `${data.name}(${data.arguments ?? ''})` : '')
  const single = rendered.replace(/\s+/g, ' ').trim()
  return single.length > limit ? `${single.slice(0, limit)}…` : single
}

/** One immutable ref as the model sees it: identity, time, kind and the start of its text. */
function lineOf(fact) {
  const at = Number.isFinite(fact.event?.time) ? new Date(fact.event.time).toISOString() : 'unknown'
  return `[${fact.ref.seq}] ${fact.ref.id} t=${at} ${fact.event?.type ?? 'event'} :: ${textOf(fact.event, SNIPPET)}`
}

/** The worker Session's ticket, which is the only ticket this tool may act for. */
function ticketOf(execution) {
  const id = execution?.agent?.id ?? execution?.sessionId
  const match = typeof id === 'string' ? /^worker-([A-Za-z0-9_-]+)$/.exec(id) : null
  return match?.[1]
}

/** Bounded views of the journal's run record, so a tool result never echoes the plan or the material back in full. */
function runView(run, sessions) {
  return {
    runId: run?.id ?? null,
    phase: run?.phase ?? 'unknown',
    plan: run?.plan ? { factCards: run.plan.factCards.length, coverage: run.plan.coverage.length, candidates: run.plan.candidates.length } : null,
    candidates: (run?.candidates ?? []).map(candidate => ({ kind: candidate.kind, status: candidate.status, ...(candidate.error ? { error: candidate.error } : {}) })),
    ...(sessions ? { sessions } : {}),
  }
}

/**
 * Registers `dream_refine` on the plugin's context.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ dream: object }} options - the Dream service this console owns
 */
export function registerDreamTool(ctx, { dream }) {
  /** Frozen material per request, kept in memory: re-reading 4 MB on every page would be the whole cost of a run. */
  const material = new Map()
  /** ticket → request bound by `claim`; one Ticket may own several Dream Inputs. */
  const bound = new Map()
  const remember = (requestId, value) => {
    material.set(requestId, value)
    while (material.size > 1) material.delete(material.keys().next().value)
    return value
  }
  const readMaterial = async (requestId, ticket) => material.get(requestId)
    ?? remember(requestId, await dream.evidence({ ticketId: ticket, ...(requestId ? { requestId } : {}) }))
  const dispose = ctx.tools.register({
    name: 'dream_refine',
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', enum: COMMANDS, description: 'The step to take; one of the commands the description lists.' },
        request: { type: 'string', description: 'Optional Dream request id, only to disambiguate; the Ticket must own it.' },
        session: { type: 'string', description: 'For evidence: the source session to page through.' },
        offset: { type: 'integer', minimum: 0, description: 'For evidence: the ref index to start at.' },
        limit: { type: 'integer', minimum: 1, maximum: MAX_REFS, description: `For evidence: refs per page, ${DEFAULT_REFS} by default.` },
        ref: { type: 'string', description: 'For evidence: one ref id, to read that event in full.' },
        plan: { type: 'object', description: 'For plan: the plan object; see the skill for its shape.' },
      },
      required: ['command'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, execution) {
      const ticketId = ticketOf(execution)
      if (!ticketId) throw new Error('dream_refine only serves a Dream refinement worker Session')
      // One Ticket may own several Dream Inputs; binding the request on claim keeps every later call on that one.
      const requestId = args.request ?? bound.get(ticketId)
      const base = { ticketId, ...(requestId ? { requestId } : {}) }
      const fail = message => { throw new Error(message) }
      if (args.command !== 'claim' && !requestId) fail('Call claim first: this run has no bound Dream request yet')
      switch (args.command) {
        case 'claim': {
          const claimed = await dream.claim(base)
          const snapshot = claimed.request?.snapshot
          if (claimed.request?.id) bound.set(ticketId, claimed.request.id)
          const sessions = (snapshot?.sessions ?? []).map(source => ({ sessionId: source.sessionId, upperBound: source.upperBound }))
          return {
            request: claimed.request?.id, mode: claimed.request?.mode, snapshotDigest: claimed.request?.snapshotDigest,
            refs: (snapshot?.refs ?? []).length, sessions,
            run: runView(claimed.run), next: 'Call evidence with one session at a time, then plan.',
          }
        }
        case 'evidence': {
          const snapshot = await readMaterial(base.requestId, ticketId)
          const sessions = snapshot.sessions ?? []
          if (args.ref) {
            const fact = sessions.flatMap(source => source.facts ?? []).find(item => item.ref?.id === args.ref)
            if (!fact) fail(`Unknown ref: ${args.ref}`)
            return { ref: fact.ref.id, session: fact.ref.sessionId, seq: fact.ref.seq, type: fact.event?.type, text: textOf(fact.event, DETAIL), ...(fact.sourceCall ? { call: textOf(fact.sourceCall, DETAIL) } : {}) }
          }
          if (!args.session) return { sessions: sessions.map(source => ({ sessionId: source.sessionId, refs: (source.facts ?? []).length, upperBound: source.upperBound })) }
          const source = sessions.find(item => item.sessionId === args.session)
          if (!source) fail(`Unknown session: ${args.session}`)
          const facts = source.facts ?? []
          const offset = args.offset ?? 0, limit = Math.min(args.limit ?? DEFAULT_REFS, MAX_REFS)
          const page = facts.slice(offset, offset + limit)
          return {
            session: source.sessionId, total: facts.length, offset, limit,
            refs: page.map(lineOf),
            next: offset + page.length < facts.length ? { session: source.sessionId, offset: offset + page.length } : null,
            ...(offset === 0 ? { firstRef: facts[0]?.ref.id ?? null } : {}),
          }
        }
        case 'baseline': {
          const value = await dream.baseline(base)
          // The harness owner reports a publication list; older/other owners wrap it.
          const listed = Array.isArray(value?.skills) ? value.skills : Object.values(value?.skills?.skills ?? value?.skills?.entries ?? {}).flat()
          return {
            persona: value?.persona ? {
              revision: value.persona.revision ?? value.persona.baseRevision ?? null,
              digest: value.persona.digest ?? value.persona.liveDigest ?? null,
              // Persona candidates must cite this exact draft digest, so it may not be dropped.
              draftDigest: value.persona.draftDigest ?? null,
            } : null,
            skills: listed.map(skill => ({ id: skill?.id ?? skill?.skillId ?? null, digest: skill?.digest ?? skill?.bundleDigest ?? null, provider: skill?.provider ?? null })),
          }
        }
        case 'plan': {
          if (!args.plan || typeof args.plan !== 'object') fail('plan needs the plan object')
          const planned = await dream.plan({ ...base, plan: args.plan })
          return runView(planned)
        }
        case 'execute': {
          const executed = await dream.execute(base)
          return { ...runView(executed), note: 'Candidates wait for a human decision in the panel; nothing is published here.' }
        }
        case 'status': {
          const current = await dream.status()
          const requestId = base.requestId ?? null
          const run = (current?.runs ?? []).find(item => item.ticketId === ticketId && (!requestId || item.requestId === requestId)) ?? null
          return runView(run)
        }
        default:
          return fail(`Unknown command: ${String(args.command)}`)
      }
    },
  })
  ctx.effect(() => () => dispose?.(), 'dsh-evolution: dispose the dream_refine tool')
}
