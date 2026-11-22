import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import type { CommandRunInput, ModelForkResult, On, PromptSubmitInput, SessionStartInput, TurnCompleteInput, TurnUsage } from 'claude-code'

const MIN = 60 * 1000
const START = 1_000_000
const session: SessionStartInput = { surface: null, isInteractive: true, cwd: '/work' }

const usage = (ctx: number): TurnUsage => ({
  input_tokens: 2, output_tokens: 10, cache_read_input_tokens: ctx, cache_creation_input_tokens: 0, model: 'claude-opus-5-5',
})
type AnsweredTurn = Exclude<TurnCompleteInput, { reason: 'refusal' }>
let turns = 0
const turn = (ctx: number, over: Partial<AnsweredTurn> = {}): TurnCompleteInput => ({
  answer: 'ok', durationMs: 1000, isAborted: false, turnId: 't' + ++turns, reason: 'answer', usage: usage(ctx), ...over,
})
const prompt = (text: string): PromptSubmitInput => ({ text, wait: false, origin: { kind: 'composer' } })
const run = (args: string): CommandRunInput => ({
  command: 'warm', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 },
})

function world(on: On, live: { tokens: number }, forkWrite = 0) {
  mock.store(on, {})
  const forks: number[] = []
  const logs: string[] = []
  const status: Array<string | undefined> = []
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'S1' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: { startedAt: START, context: { window: 1000000, tokens: live.tokens }, rateLimits: [] } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('classic.SessionStart', () => ({}))
  on('ui.log', ($, e) => { logs.push(e.text); return { value: undefined } })
  on('ui.status', ($, e) => { status.push(e.text); return { value: undefined } })
  on('model.fork', () => {
    forks.push(forks.length)
    const value: ModelForkResult = { isAnswered: true, text: 'warm', usage: { input_tokens: 2, output_tokens: 1, cache_read_input_tokens: live.tokens, cache_creation_input_tokens: forkWrite } }
    return { value }
  })
  return { forks, logs, status }
}

/** n user messages, each followed by a turn at the given context size. */
async function talk($: Parameters<TestBody>[0],n: number, ctx: number) {
  for (let i = 0; i < n; i++) {
    await $.prompt.submit(prompt('question ' + i))
    await $.turn.complete(turn(ctx))
  }
}

test('with minMessages 5: no pings before the 5th message', { options: { minMessages: 5 } }, async ($, on) => {
  const clock = mock.clock(on, { now: START })
  const live = { tokens: 100000 }
  const w = world(on, live)
  await $.session.start(session)
  await talk($, 4, 100000)
  await clock.advance(70 * MIN)
  expect(w.forks.length).toBe(0)
})

test('after 5 messages and above the token threshold, a ping goes out after 50 minutes', async ($, on) => {
  const clock = mock.clock(on, { now: START })
  const live = { tokens: 100000 }
  const w = world(on, live)
  await $.session.start(session)
  await talk($, 5, 100000)
  expect(w.logs.some(l => l.includes('threshold reached'))).toBe(true)
  await clock.advance(49 * MIN)
  expect(w.forks.length).toBe(0)
  await clock.advance(MIN)
  expect(w.forks.length).toBe(1)
  await clock.advance(50 * MIN)
  expect(w.forks.length).toBe(2)
})

test('a small context does not trigger pings, even after many messages', async ($, on) => {
  const clock = mock.clock(on, { now: START })
  const live = { tokens: 20000 }
  const w = world(on, live)
  await $.session.start(session)
  await talk($, 8, 20000)
  await clock.advance(60 * MIN)
  expect(w.forks.length).toBe(0)
})

test('the window ends: pings stop 2h after the last message', async ($, on) => {
  const clock = mock.clock(on, { now: START })
  const live = { tokens: 100000 }
  const w = world(on, live)
  await $.session.start(session)
  await talk($, 5, 100000)
  await clock.advance(5 * 60 * MIN)
  // At 50 and 100 minutes; a third ping (150 min) would fall after the window ends (120 min).
  expect(w.forks.length).toBe(2)
})

test('the break budget stops pings', { options: { pingFloor: 30, windowHours: 24 } }, async ($, on) => {
  const clock = mock.clock(on, { now: START })
  const live = { tokens: 100000 }
  const w = world(on, live)
  await $.session.start(session)
  await talk($, 5, 100000)
  await clock.advance(10 * 60 * MIN)
  // Opus 5.5: a ping is about 1/40 of a write, the budget is 1/30: one ping fits, the second does not.
  expect(w.forks.length).toBe(1)
  expect(w.logs.some(l => l.includes('break budget'))).toBe(true)
})

test('/warm off disables, /warm auto restores', async ($, on) => {
  const clock = mock.clock(on, { now: START })
  const live = { tokens: 100000 }
  const w = world(on, live)
  await $.session.start(session)
  await talk($, 5, 100000)
  await $.command.run(run('off'))
  await clock.advance(60 * MIN)
  expect(w.forks.length).toBe(0)
  await talk($, 1, 100000)
  await clock.advance(55 * MIN)
  expect(w.forks.length).toBe(0)
  // After 55 min the cache is still alive and the ping is overdue: auto pings right away.
  await $.command.run(run('auto'))
  await clock.advance(MIN)
  expect(w.forks.length).toBe(1)
})

// minMessages 5 so pings do not warm the cache before the user returns.
test('sending on a cold cache shows the cost (guard warn)', { options: { minMessages: 5 } }, async ($, on) => {
  const clock = mock.clock(on, { now: START })
  const live = { tokens: 100000 }
  const w = world(on, live)
  await $.session.start(session)
  await talk($, 2, 100000)
  await clock.advance(90 * MIN)
  await $.prompt.submit(prompt('back again'))
  expect(w.logs.some(l => l.includes('cache expired') && l.includes('$0.800'))).toBe(true)
})

test('by default the token threshold is enough: a ping after the first message', async ($, on) => {
  const clock = mock.clock(on, { now: START })
  const w = world(on, { tokens: 60000 })
  await $.session.start(session)
  await talk($, 1, 60000)
  await clock.advance(50 * MIN)
  expect(w.forks.length).toBe(1)
})

test('the /compact hint shows once per conversation from 150k', async ($, on) => {
  mock.clock(on, { now: START })
  const live = { tokens: 100000 }
  const w = world(on, live)
  await $.session.start(session)
  await talk($, 1, 100000)
  expect(w.logs.some(l => l.includes('/compact'))).toBe(false)
  live.tokens = 160000
  await talk($, 2, 160000)
  expect(w.logs.filter(l => l.includes('Same topic: /compact')).length).toBe(1)
})

test('/clear resets the message counter', { options: { minMessages: 5 } }, async ($, on) => {
  const clock = mock.clock(on, { now: START })
  const live = { tokens: 100000 }
  const w = world(on, live)
  await $.session.start(session)
  await talk($, 4, 100000)
  await $.classic.SessionStart({ source: 'clear' })
  await talk($, 1, 100000)
  await clock.advance(60 * MIN)
  expect(w.forks.length).toBe(0)
})
