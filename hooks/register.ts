// warm-cache: keeps the 1-hour prompt cache warm during breaks, but only once the conversation
// is large enough that rewriting the context actually costs money.
// The ping mechanism (forking the conversation with a short prompt) and the price table come from
// cache-tax (https://github.com/karanb192/cache-tax, MIT, Karan Bansal).
import type { EngineInterface, Register } from 'claude-code'

const MIN = 60 * 1000
const TTL_MS = 60 * MIN
const PING_AFTER_MS = 50 * MIN
const RETRY_MS = 2 * MIN
const REFRESH_MS = MIN
/** A ping that wrote more than this share of what it read missed the cache. */
const WARM_WRITE_SHARE = 0.1
const PING_PROMPT = 'Reply with the single word: warm'
const SEND = 'Send'
const KEEP = "Don't send"

/** $ per million tokens: [cache read, 1h cache write, output]. From cache-tax, prices as of November 2026. */
type Price = [number, number, number]
const OPUS_4_5: Price = [0.5, 10, 25]
const OPUS_4: Price = [1.5, 30, 75]
const SONNET_4: Price = [0.3, 6, 15]
const PRICES: Record<string, Price> = {
  'fable-5-2': [0.2, 16, 40], 'mythos-5-2': [0.2, 16, 40],
  'fable-5-1': [0.25, 20, 50], 'mythos-5-1': [0.25, 20, 50],
  'fable-5': [1, 20, 50], 'mythos-5': [1, 20, 50],
  'opus-5-5': [0.2, 8, 20], 'opus-5': [0.5, 10, 25],
  'opus-4-8': OPUS_4_5, 'opus-4-7': OPUS_4_5, 'opus-4-6': OPUS_4_5, 'opus-4-5': OPUS_4_5,
  'opus-4-1': OPUS_4, 'opus-4': OPUS_4,
  'sonnet-5-5': [0.1, 4, 10], 'sonnet-5': [0.2, 4, 10],
  'sonnet-4-6': SONNET_4, 'sonnet-4-5': SONNET_4, 'sonnet-4': SONNET_4,
  'haiku-5-5': [0.01, 0.2, 0.5], 'haiku-4-5': [0.1, 2, 5],
}
/** Ratios used for the budget when the model is not in the table: read 0.1x, 1h write 2x, output 5x the input price. */
const FALLBACK: Price = [0.1, 2, 5]

export function familyOf(model: string | null): string {
  let m = (model ?? '').trim().toLowerCase().replace(/\[1m\]$/, '')
  const wrapper = /^(?:(?:us|eu|apac|global)\.)?anthropic\./
  if (wrapper.test(m)) m = m.replace(wrapper, '').replace(/-v\d+(?::\d+)?$/, '')
  return m.replace(/[\s.]+/g, '-').replace(/^claude-/, '').replace(/[-@]20\d{6}$/, '')
}

function priceOf(model: string | null): Price | null {
  const f = familyOf(model)
  return Object.hasOwn(PRICES, f) ? PRICES[f]! : null
}

export type Guard = 'warn' | 'ask' | 'off'
export type Options = { minMessages: number; minTokens: number; windowMs: number; pingFloor: number; guard: Guard; display: 'band' | 'status'; compactHint: number }

const num = (v: unknown, def: number, min: number, max = Infinity) =>
  typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : def

export function optionsFrom(o: Readonly<Record<string, unknown>> | undefined): Options {
  return {
    minMessages: Math.floor(num(o?.minMessages, 0, 0)),
    compactHint: Math.floor(num(o?.compactHint, 150000, 0)),
    minTokens: Math.floor(num(o?.minTokens, 40000, 0)),
    windowMs: num(o?.windowHours, 2, 1, 24) * 60 * MIN,
    pingFloor: num(o?.pingFloor, 2, 0),
    guard: o?.guard === 'ask' || o?.guard === 'off' ? o.guard : 'warn',
    display: o?.display === 'status' ? 'status' : 'band',
  }
}

/** auto: thresholds decide; on: ping regardless of thresholds; off: no pings in this conversation. */
type Mode = 'auto' | 'on' | 'off'
type Usage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }

export type State = {
  mode: Mode
  userMsgs: number
  ctx: number
  model: string | null
  /** When the last request that refreshed the cache was sent (a turn or a ping). */
  lastRequestAt: number
  /** Whether the current turn has already sent a request (turn.step). */
  steppedThisTurn: boolean
  deadline: number
  pending: { cancel: () => void } | null
  refresh: { cancel: () => void } | null
  inFlight: boolean
  retried: boolean
  /** Bumped on /clear, compaction and stop, so a ping sent earlier no longer counts. */
  gen: number
  tick: number
  waitForTurn: boolean
  stopped: string | null
  /** Cost of pings in this break, in cache-write-equivalent tokens. */
  idleCost: number
  idleUsd: number | null
  idlePings: number
  lastPingCost: number | null
  hasBand: boolean
  /** Whether the /compact hint has already been shown in this conversation. */
  hinted: boolean
}

export function freshState(): State {
  return {
    mode: 'auto', userMsgs: 0, ctx: 0, model: null, lastRequestAt: 0, steppedThisTurn: false, deadline: 0,
    pending: null, refresh: null, inFlight: false, retried: false, gen: 0, tick: 0, waitForTurn: false, stopped: null,
    idleCost: 0, idleUsd: 0, idlePings: 0, lastPingCost: null, hasBand: false, hinted: false,
  }
}

export function eligible(s: State, o: Options): boolean {
  if (s.mode === 'off') return false
  if (s.mode === 'on') return s.ctx > 0
  return s.userMsgs >= o.minMessages && s.ctx >= o.minTokens && s.ctx > 0
}

function isCold(s: State, now: number): boolean {
  return s.lastRequestAt > 0 && now - s.lastRequestAt >= TTL_MS
}

/** Ping cost in write-equivalent tokens: writes count 1:1, the rest by the model's price ratios. */
function pingCost(u: Usage, p: Price): number {
  return u.cache_read_input_tokens * p[0] / p[1] + u.cache_creation_input_tokens + u.input_tokens * 0.5 + u.output_tokens * p[2] / p[1]
}

/** Rewriting the whole context costs, in the same units, simply ctx. */
export function overBudget(s: State, o: Options): boolean {
  if (o.pingFloor <= 0 || s.ctx <= 0) return false
  const p = priceOf(s.model) ?? FALLBACK
  const next = s.lastPingCost ?? (s.ctx * p[0] / p[1] + 5 * p[2] / p[1])
  return s.idleCost + next > s.ctx / o.pingFloor
}

const fmtTok = (n: number) => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1000 ? Math.round(n / 1000) + 'k' : String(n)
const fmtUsd = (usd: number | null) => usd == null ? '' : '$' + usd.toFixed(usd < 1 ? 3 : 2)
export function fmtDur(ms: number): string {
  const t = Math.max(0, Math.round(ms / MIN))
  return t >= 60 ? `${Math.floor(t / 60)}h${String(t % 60).padStart(2, '0')}m` : `${t}m`
}

function coldUsd(s: State): number | null {
  const p = priceOf(s.model)
  return p ? s.ctx * p[1] / 1e6 : null
}

export function statusText(s: State, o: Options, now: number): string {
  if (s.mode === 'off') return 'off in this conversation (/warm auto)'
  if (s.stopped && !s.deadline) return `stopped: ${s.stopped}`
  if (!s.deadline) {
    if (!s.ctx && !s.userMsgs) return ''
    const msgs = o.minMessages ? `${Math.min(s.userMsgs, o.minMessages)}/${o.minMessages} msgs` : ''
    const tok = o.minTokens ? `${fmtTok(s.ctx)}/${fmtTok(o.minTokens)} tok` : `${fmtTok(s.ctx)} tok`
    return `waiting for threshold · ${[msgs, tok].filter(Boolean).join(' · ')}`
  }
  const next = !s.lastRequestAt ? 'waiting for the first turn'
    : isCold(s, now) ? 'cache already cold'
    : s.waitForTurn ? 'first ping after the next turn'
    : `ping in ${fmtDur(s.lastRequestAt + PING_AFTER_MS - now)}`
  const spent = s.idlePings ? ` · break: ${s.idlePings} ping${s.idlePings === 1 ? '' : 's'}${s.idleUsd ? ' ' + fmtUsd(s.idleUsd) : ''}` : ''
  const big = o.compactHint && s.ctx >= o.compactHint ? ' · large context: /compact or a new session' : ''
  return `ON · ${next} · window ${fmtDur(s.deadline - now)} · context ${fmtTok(s.ctx)}${spent}${big}`
}

type Ctx = { s: State; o: Options }

async function redraw($: EngineInterface, c: Ctx) {
  const { s, o } = c
  const now = await $.clock.now()
  if (s.hasBand) $.ui.invalidate('ui.render')
  else {
    const text = statusText(s, o, now)
    $.ui.status(text ? `warm-cache · ${text}` : undefined)
  }
  // The countdown refreshes every minute, but only while the window is open.
  if (s.deadline && !s.refresh) s.refresh = $.clock.every(REFRESH_MS, () => { void redraw($, c) })
  else if (!s.deadline && s.refresh) { s.refresh.cancel(); s.refresh = null }
}

function disarm(s: State) {
  s.pending?.cancel()
  s.pending = null
  s.tick++
}

async function stop($: EngineInterface, c: Ctx, why: string | null) {
  const { s, o } = c
  s.deadline = 0
  s.stopped = why
  s.gen++
  disarm(s)
  await redraw($, c)
}

async function arm($: EngineInterface, c: Ctx): Promise<void> {
  const { s, o } = c
  disarm(s)
  if (!s.deadline) return redraw($, c)
  const now = await $.clock.now()
  disarm(s)
  if (now >= s.deadline) return stop($, c, null)
  const due = s.lastRequestAt + PING_AFTER_MS
  if (!s.lastRequestAt || s.waitForTurn || isCold(s, now) || due >= s.deadline) {
    // Nothing to ping: just wake up at the end of the window.
    s.pending = $.clock.after(s.deadline - now, () => { void arm($, c) })
  } else {
    s.pending = $.clock.after(Math.max(1000, due - now), () => { void ping($, c) })
  }
  await redraw($, c)
}

async function ping($: EngineInterface, c: Ctx): Promise<void> {
  const { s, o } = c
  s.pending = null
  const tick = s.tick
  const model = await $.session.model()
  const now = await $.clock.now()
  if (s.tick !== tick || s.inFlight || !s.deadline) return
  if (model) s.model = model
  if (now >= s.deadline) return arm($, c)
  if (!s.lastRequestAt || isCold(s, now)) return stop($, c, 'cache expired before the ping')
  if (now - s.lastRequestAt < PING_AFTER_MS - 1000) return arm($, c)
  if (overBudget(s, o)) {
    $.ui.log(`warm-cache: break budget reached (${s.idlePings} pings). The cache will expire and your next message will rewrite ${fmtTok(s.ctx)} tokens${coldUsd(s) == null ? '' : `, about ${fmtUsd(coldUsd(s))}`}.`)
    return stop($, c, 'break budget reached')
  }
  const gen = s.gen
  const sentAt = s.lastRequestAt
  s.inFlight = true
  const sent = await $.model.fork({ prompt: PING_PROMPT }).then(reply => ({ reply }), (err: unknown) => ({ err }))
  const at = await $.clock.now()
  s.inFlight = false
  // A ping sent for stale state (/clear, compaction, stop, a new turn) does not count.
  if (gen !== s.gen || s.lastRequestAt !== sentAt) return s.pending ? undefined : arm($, c)
  if ('err' in sent) return stop($, c, `ping failed: ${sent.err instanceof Error ? sent.err.message : String(sent.err)}`)
  const r = sent.reply
  if (!r) return stop($, c, 'the engine did not send the ping')
  if (!r.isAnswered) {
    if (r.reason === 'nothing-to-fork') {
      s.waitForTurn = true
      return arm($, c)
    }
    const transient = r.reason === 'api-error' && (r.status === null || r.status === 429 || r.status >= 500)
    if (transient && !s.retried && at + RETRY_MS < s.lastRequestAt + TTL_MS - MIN) {
      s.retried = true
      disarm(s)
      s.pending = $.clock.after(RETRY_MS, () => { void ping($, c) })
      return redraw($, c)
    }
    return stop($, c, r.reason === 'api-error' ? `API error${r.status == null ? '' : ` (${r.status})`}` : 'ping got no answer')
  }
  s.retried = false
  const u = r.usage
  const p = priceOf(model) ?? FALLBACK
  const cost = pingCost(u, p)
  s.idleCost += cost
  s.idlePings++
  s.lastPingCost = cost
  const real = priceOf(model)
  const usd = real ? (u.cache_read_input_tokens * real[0] + u.cache_creation_input_tokens * real[1] + u.input_tokens * real[1] / 2 + u.output_tokens * real[2]) / 1e6 : null
  s.idleUsd = s.idleUsd == null || usd == null ? null : s.idleUsd + usd
  const warm = u.cache_read_input_tokens > 0 && u.cache_creation_input_tokens < WARM_WRITE_SHARE * u.cache_read_input_tokens
  if (!warm) return stop($, c, `ping wrote ${fmtTok(u.cache_creation_input_tokens)} tok, the cache was already gone`)
  s.lastRequestAt = now
  return arm($, c)
}

/** A new conversation in the same process: start from scratch. */
async function reset($: EngineInterface, c: Ctx) {
  const { s, o } = c
  s.pending?.cancel()
  Object.assign(s, freshState(), { hasBand: s.hasBand, gen: s.gen + 1, tick: s.tick + 1, refresh: s.refresh })
  await redraw($, c)
}

export const register: Register = (on, options) => {
  const o = optionsFrom(options)
  const s = freshState()
  const c: Ctx = { s, o }

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const rest = await next(e)
    if (!s.hasBand || e.props.hasSurvey) return rest
    const text = statusText(s, o, await $.clock.now())
    if (!text) return rest
    const { Box, Text } = $.ui.resolve(e)
    const active = Boolean(s.deadline)
    return Box({ flexDirection: 'column', children: [
      rest,
      Text({ dimColor: !active, children: [Text({ color: active ? 'success' : undefined, bold: active, children: ['warm-cache'] }), ` · ${text}`] }),
    ] })
  })

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    s.hasBand = o.display === 'band' && (e.surface === 'terminal' || e.surface === 'desktop')
    s.model = await $.session.model()
    const usage = await $.session.usage()
    if (usage.context.tokens) s.ctx = usage.context.tokens
    await $.command.register({
      name: 'warm',
      description: 'Keep the prompt cache warm: status, on (ignore thresholds), off (this conversation), auto (use thresholds)',
      argumentHint: '[status | on | off | auto]',
      immediate: true,
    })
    await redraw($, c)
    return r
  })

  on('classic.SessionStart', async ($, e, next) => {
    const r = await next(e)
    if (e.source === 'clear') return (await reset($, c), r)
    if (e.source === 'resume' || e.source === 'fork') {
      // A resumed conversation with a large context is already long, so treat the message threshold as met.
      if (typeof e.context_tokens === 'number' && e.context_tokens > 0) s.ctx = e.context_tokens
      if (typeof e.seconds_since_last_response === 'number') s.lastRequestAt = (await $.clock.now()) - e.seconds_since_last_response * 1000
      if (typeof e.model === 'string') s.model = e.model
      if (s.ctx >= o.minTokens) s.userMsgs = Math.max(s.userMsgs, o.minMessages)
      await redraw($, c)
    }
    return r
  })

  on('command.run', { command: 'warm' }, async ($, e) => {
    const arg = String(e.args ?? '').trim().toLowerCase()
    const now = await $.clock.now()
    if (arg === 'off') {
      s.mode = 'off'
      await stop($, c, null)
      return { text: 'warm-cache: off for the rest of this conversation. /warm auto turns thresholds back on.' }
    }
    if (arg === 'on' || arg === 'auto') {
      s.mode = arg
      s.stopped = null
      if (eligible(s, o) && s.lastRequestAt && !isCold(s, now)) {
        s.deadline = Math.max(s.deadline, s.lastRequestAt + o.windowMs)
        await arm($, c)
      } else if (!eligible(s, o)) await stop($, c, null)
      else await redraw($, c)
      return { text: `warm-cache: mode ${arg}. ${statusText(s, o, now) || 'Waiting for the first turn.'}` }
    }
    if (arg && arg !== 'status') return { text: 'warm-cache: usage /warm [status | on | off | auto]' }
    const p = priceOf(s.model)
    const lines = [
      `mode        ${s.mode}`,
      `thresholds  ${o.minMessages} msgs and ${fmtTok(o.minTokens)} tok · window ${fmtDur(o.windowMs)} · break budget 1/${o.pingFloor || '∞'} of a rewrite`,
      `chat        ${s.userMsgs} msgs · context ${s.ctx.toLocaleString('en-US')} tok · ${s.model ?? 'unknown model'}`,
      `cache       ${!s.lastRequestAt ? 'no requests yet' : isCold(s, now) ? `cold for ${fmtDur(now - s.lastRequestAt - TTL_MS)}` : `warm for ${fmtDur(s.lastRequestAt + TTL_MS - now)} more`}`,
      `cold write  ${p ? fmtUsd(s.ctx * p[1] / 1e6) + ' · ' : ''}ping ${p ? fmtUsd(s.ctx * p[0] / 1e6) : `about ${Math.round(100 * FALLBACK[0] / FALLBACK[1])}% of a write`}`,
      `state       ${statusText(s, o, now) || 'nothing sent yet'}`,
    ]
    return { text: lines.join('\n') }
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'plugin' || typeof e.text !== 'string' || e.text.trimStart().startsWith('/')) return next(e)
    const now = await $.clock.now()
    if (o.guard !== 'off' && isCold(s, now) && s.ctx >= Math.max(o.minTokens, 1)) {
      const usd = coldUsd(s)
      const what = `cache expired ${fmtDur(now - s.lastRequestAt - TTL_MS)} ago, this message will rewrite ${fmtTok(s.ctx)} tokens${usd == null ? '' : ` (about ${fmtUsd(usd)})`}.`
      if (o.guard === 'ask') {
        let answer: string | null = null
        try { answer = await $.ui.ask(`warm-cache: ${what} Send it?`, { header: 'warm-cache', options: [SEND, KEEP] }) } catch { answer = null }
        if (answer === KEEP) return { drop: 'warm-cache: not sent. Consider /compact, or /clear with a short summary.' }
      } else $.ui.log(`warm-cache: ${what}`)
    }
    const r = await next(e)
    s.userMsgs++
    return r
  })

  on('turn.step', async function* ($, e, next) {
    if (!e.agentId) {
      s.lastRequestAt = await $.clock.now()
      s.steppedThisTurn = true
    }
    return yield* next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId) return r
    const now = await $.clock.now()
    const touched = Boolean(e.usage) || (!e.isAborted && e.reason !== 'error')
    if (!touched) return r
    if (!s.steppedThisTurn) s.lastRequestAt = now
    s.steppedThisTurn = false
    if (e.usage?.model) s.model = e.usage.model
    const live = (await $.session.usage()).context.tokens
    if (live && live > 0) s.ctx = live
    else if (e.usage) s.ctx = e.usage.input_tokens + e.usage.cache_read_input_tokens + e.usage.cache_creation_input_tokens
    // A new break: reset the ping cost counter.
    s.idleCost = 0
    s.idleUsd = 0
    s.idlePings = 0
    s.waitForTurn = false
    s.retried = false
    if (o.compactHint && s.ctx >= o.compactHint && !s.hinted) {
      s.hinted = true
      const p = priceOf(s.model)
      const perTurn = p ? `, about ${fmtUsd(s.ctx * p[0] / 1e6)} just to read it from a warm cache` : ''
      $.ui.log(`warm-cache: the context is ${fmtTok(s.ctx)} tokens and every message reads all of it${perTurn}. New topic: /clear or a new session. Same topic: /compact.`)
    }
    if (eligible(s, o)) {
      if (!s.deadline) $.ui.log(`warm-cache: threshold reached (${s.userMsgs} msgs, ${fmtTok(s.ctx)} tok). The cache will be kept warm for up to ${fmtDur(o.windowMs)} after each message. /warm off turns it off.`)
      s.stopped = null
      s.deadline = now + o.windowMs
    }
    await arm($, c)
    return r
  })

  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    if (!e.agentId && e.trigger !== 'precompute' && r.skip === undefined) {
      // After compaction the context is new and small; the threshold is checked again on the next turn.
      s.ctx = 0
      s.hinted = false
      s.gen++
      s.deadline = 0
      disarm(s)
      await redraw($, c)
    }
    return r
  })
}
