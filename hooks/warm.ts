// Two buttons that look after the prompt cache and the session limit.
//
// 🔥 Keep warm: while it is on and nobody types, a one-word ping goes out a
// few minutes before the cache expires, so the next real message reads the
// cache cheaply.
//   - A real message restarts the cache's hour, so no ping goes out while the
//     person is working, and it starts the ping count over.
//   - At most MAX_PINGS in a row with nobody typing, then it turns itself off.
//   - Near the five-hour or weekly limit it pauses, and stays paused until the
//     person's next message after the reset.
//
// 🛡️ Shield: armed, it pauses a running task before the session limit stops
// it, keeps the cache warm until the limit resets, then sends "continue".
//   - It triggers by itself once the limit reaches the point where what is
//     left only just covers the hold: the pings until the reset, at what one
//     ping was measured to cost, plus a margin for Claude to wrap up. Until a
//     ping has been measured, at a fixed point (85% unless set).
//   - Pressed while armed, it pauses at once.
//   - The pause blocks Claude's next tool call with the reason, so Claude
//     stops between steps, notes where it is, and ends its turn.
//   - If the limit is hit anyway, it still sends "continue" after the reset.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, EventOf, Register } from 'claude-code'

import type { Hold, Stats, Warm } from '../types'
import { CACHE, HOLD, STATS, WARM } from './state'

const cache = atom({ plugin: 'mark-2-hud', key: 'cache' } as const, CACHE)
const hold = atom({ plugin: 'mark-2-hud', key: 'hold' } as const, HOLD)
const isBusy = atom({ plugin: 'mark-2-hud', key: 'isBusy' } as const, false)
const stats = atom({ plugin: 'mark-2-hud', key: 'stats' } as const, STATS)
const warm = atom({ plugin: 'mark-2-hud', key: 'warm' } as const, WARM)

type On = Parameters<Register>[0]

// Keep-warm pauses at these: what is left of the limit is not spent on pings.
const PAUSE_AT = 98
const PAUSE_WEEK_AT = 95
export const MAX_PINGS = 4
// A ping goes out with this much of the cache's hour left.
const PING_AT_S = 3 * 60
// While holding, pinging stops this close to the limit: one more would hit it.
const HOLD_STOP_AT = 99.5
// What the shield keeps back for Claude to finish its step and write its note.
const WRAP_UP_PERCENT = 3
// A ping restarts the hour and the next goes out 3 minutes before its end.
const PING_EVERY_MS = 57 * 60 * 1000
// "continue" goes out this long after the reset, so the new window is open.
const RESUME_SLACK_MS = 60 * 1000
// Below a reading's resolution (0.1), a ping is counted as this much.
const MIN_PING_PERCENT = 0.1

// The marker that tells a ping's turn from the person's.
export const WARM_MARK = '[mark-2-hud keep-warm]'
const PING = `${WARM_MARK} Cache keep-alive. Reply with the single word: ok. Use no tools.`
const RESUME = 'continue'
const PAUSE_REASON =
  "Paused by Mark-2 HUD's shield: the session limit is nearly reached. Don't start anything new. " +
  'In one or two short sentences, note what is done and what comes next, then end your turn. ' +
  "You'll get \"continue\" once the limit resets."
// Mark-2 HUD's own tools stay open during a pause, so the plan bar can still be updated.
const OPEN_TOOLS = ['mcp__mark-2-hud__progress', 'mcp__mark-2-hud__step']

export const isPingText = (text: string): boolean => text.includes(WARM_MARK)

// The Cache & limit panel, beside the transcript like the agents panel.
export const LIMITS_PANE = 'mark-2-hud-limits'
const LIMITS_TITLE = 'Cache & limit'

export async function toggleLimits($: EngineInterface): Promise<boolean> {
  const isOpen = (await $.ui.panes()).some(p => p.id === LIMITS_PANE)
  if (isOpen) await $.ui.close({ id: LIMITS_PANE })
  else await $.ui.open({ id: LIMITS_PANE, title: LIMITS_TITLE })
  return !isOpen
}

// The shield opens it when it starts a pause, so the hold can be followed.
async function showLimits($: EngineInterface): Promise<void> {
  await $.ui.open({ id: LIMITS_PANE, title: LIMITS_TITLE }).catch(() => undefined)
}

export type WarmLimits = Pick<Stats, 'limit' | 'weekLimit' | 'limitResetsAt' | 'weekResetsAt'>

// Whether keep-warm's limits call for a pause, and until when (null: unknown).
export const pauseFor = (s: WarmLimits): { isDue: boolean; until: number | null } =>
  (s.limit ?? 0) >= PAUSE_AT
    ? { isDue: true, until: s.limitResetsAt }
    : (s.weekLimit ?? 0) >= PAUSE_WEEK_AT
      ? { isDue: true, until: s.weekResetsAt }
      : { isDue: false, until: null }

// Whether the cache is warm, about to expire, and Claude idle with no ping in flight.
const isCacheDue = (secondsLeft: number | null, isWorking: boolean, isPinging: boolean): boolean =>
  !isPinging && !isWorking && secondsLeft !== null && secondsLeft > 0 && secondsLeft <= PING_AT_S

// Whether keep-warm's ping is due.
export const isPingDue = (w: Warm, secondsLeft: number | null, isWorking: boolean): boolean =>
  w.status === 'on' && isCacheDue(secondsLeft, isWorking, w.isPinging)

// The limit, in percent, at which the armed shield pauses: what is left then
// covers the pings until the reset and the wrap-up. The fixed point until a
// ping has been measured or while the reset time is unknown.
export const triggerPoint = (
  s: Pick<Stats, 'limitResetsAt'>,
  pingPercent: number | null,
  fallbackAt: number,
  now: number,
): number => {
  if (pingPercent === null || s.limitResetsAt === null) return fallbackAt
  const pings = Math.ceil(Math.max(0, s.limitResetsAt - now) / PING_EVERY_MS)
  const need = pings * pingPercent + WRAP_UP_PERCENT
  return Math.round(Math.min(97, Math.max(50, 100 - need)))
}

// --- keep-warm (🔥) ---------------------------------------------------------

export async function setWarm($: EngineInterface, isOn: boolean): Promise<void> {
  await update($, warm, w => ({ ...w, status: isOn ? ('on' as const) : ('off' as const), sent: 0, pausedUntil: null }))
}

export async function toggleWarm($: EngineInterface): Promise<boolean> {
  const isOn = ({ ...WARM, ...(await read($, warm)) }).status === 'off'
  await setWarm($, isOn)
  return isOn
}

// Sends one ping, noting the limit before it so its cost can be measured.
async function sendPing($: EngineInterface): Promise<boolean> {
  const { limit } = { ...STATS, ...(await read($, stats)) }
  await update($, warm, w => ({ ...w, isPinging: true, limitAtPing: limit }))
  const sent = await $.prompt.submit({ text: PING }).catch(() => ({ drop: 'failed' as const }))
  if (sent.drop === undefined) return true
  await update($, warm, w => ({ ...w, isPinging: false, limitAtPing: null }))
  return false
}

async function warmTick($: EngineInterface, secondsLeft: number | null, isWorking: boolean) {
  const w = { ...WARM, ...(await read($, warm)) }
  if (w.status !== 'on') return

  const pause = pauseFor({ ...STATS, ...(await read($, stats)) })
  if (pause.isDue) {
    await update($, warm, was => ({ ...was, status: 'paused' as const, pausedUntil: pause.until }))
    return
  }
  if (!isPingDue(w, secondsLeft, isWorking)) return

  if (w.sent >= MAX_PINGS) {
    await setWarm($, false)
    $.ui.toast(`Keep warm turned off after ${MAX_PINGS} pings with nobody typing.`, { timeoutMs: 15000 })
    return
  }
  if (await sendPing($)) await update($, warm, was => ({ ...was, sent: was.sent + 1 }))
}

// --- shield (🛡️) ------------------------------------------------------------

export async function setShield($: EngineInterface, isOn: boolean): Promise<void> {
  await update($, hold, h => ({ ...h, status: isOn ? ('armed' as const) : ('off' as const), resumeAt: null, pings: 0 }))
}

export async function setShieldAt($: EngineInterface, percent: number): Promise<void> {
  await update($, hold, h => ({ ...h, fallbackAt: Math.round(Math.min(97, Math.max(50, percent))) }))
}

// Pauses now: a running task stops at its next tool call; with Claude idle,
// the hold starts at once.
export async function pauseNow($: EngineInterface): Promise<void> {
  const isWorking = await read($, isBusy)
  const { limitResetsAt } = { ...STATS, ...(await read($, stats)) }
  await update($, hold, h =>
    isWorking
      ? { ...h, status: 'pausing' as const }
      : { ...h, status: 'holding' as const, resumeAt: limitResetsAt === null ? null : limitResetsAt + RESUME_SLACK_MS },
  )
  $.ui.toast(
    isWorking
      ? '🛡️ Pausing: Claude stops at its next step and waits for the limit to reset.'
      : '🛡️ Holding: the cache is kept warm until the limit resets, then "continue" goes out.',
    { timeoutMs: 10000 },
  )
  await showLimits($)
}

// The button: off arms it, armed pauses now, and any other state turns it off.
export async function pressShield($: EngineInterface): Promise<void> {
  const { status } = { ...HOLD, ...(await read($, hold)) }
  if (status === 'off') await setShield($, true)
  else if (status === 'armed') await pauseNow($)
  else await setShield($, false)
}

async function shieldTick($: EngineInterface, secondsLeft: number | null, isWorking: boolean, now: number): Promise<boolean> {
  const h = { ...HOLD, ...(await read($, hold)) }
  const s = { ...STATS, ...(await read($, stats)) }
  const w = { ...WARM, ...(await read($, warm)) }

  if (h.status === 'armed') {
    if (isWorking && s.limit !== null && s.limit >= triggerPoint(s, w.pingPercent, h.fallbackAt, now)) {
      await update($, hold, was => ({ ...was, status: 'pausing' as const }))
      $.ui.toast(`🛡️ Session limit at ${Math.round(s.limit)}%: pausing at Claude's next step.`, { timeoutMs: 12000 })
      await showLimits($)
    }
    return false
  }
  if (h.status !== 'holding' && h.status !== 'waiting') return h.status === 'pausing'

  // The reset time may only arrive with a later reading.
  const resumeAt = h.resumeAt ?? (s.limitResetsAt === null ? null : s.limitResetsAt + RESUME_SLACK_MS)
  if (resumeAt !== h.resumeAt) await update($, hold, was => ({ ...was, resumeAt }))

  if (resumeAt !== null && now >= resumeAt) {
    if (isWorking || w.isPinging) return true
    // Back to armed first, so the turn "continue" starts is the person's own.
    await update($, hold, was => ({ ...was, status: 'armed' as const, resumeAt: null, pings: 0 }))
    const sent = await $.prompt.submit({ text: RESUME, asUser: true }).catch(() => ({ drop: 'failed' as const }))
    if (sent.drop !== undefined) {
      await update($, hold, was => ({ ...was, status: h.status, resumeAt }))
    } else {
      $.ui.toast('🛡️ Session limit reset: Claude is continuing.', { timeoutMs: 10000 })
    }
    return true
  }

  if (h.status === 'holding' && (s.limit ?? 0) < HOLD_STOP_AT && isCacheDue(secondsLeft, isWorking, w.isPinging)) {
    if (await sendPing($)) await update($, hold, was => ({ ...was, pings: was.pings + 1 }))
  }
  return true
}

// --- shared -----------------------------------------------------------------

async function tick($: EngineInterface) {
  const { secondsLeft } = await read($, cache)
  const isWorking = await read($, isBusy)
  // While the shield pauses or holds, its pings stand in for keep-warm's.
  if (await shieldTick($, secondsLeft, isWorking, await $.clock.now())) return
  await warmTick($, secondsLeft, isWorking)
}

// Their part of `session.start`: a check every five seconds.
export function warmSessionStart($: EngineInterface): void {
  // A reload keeps the values: a ping in flight then never completes here, and
  // a value an earlier version saved gets the fields it lacks.
  void update($, warm, w => ({ ...WARM, ...w, isPinging: false, limitAtPing: null }))
  void update($, hold, h => ({ ...HOLD, ...h }))
  void update($, stats, s => ({ ...STATS, ...s }))
  $.clock.every(5000, () => tick($))
}

// Their part of `turn.start`: the person's own message starts keep-warm's count
// over and ends its pause once the limit has eased; typed during a hold, it
// takes the task back, and the shield returns to armed.
export async function warmTurnStart($: EngineInterface, e: EventOf['turn.start']): Promise<void> {
  if (e.agentId !== undefined || isPingText(e.text)) return
  const isPaused = ({ ...WARM, ...(await read($, warm)) }).status === 'paused'
  const isEased = !pauseFor({ ...STATS, ...(await read($, stats)) }).isDue
  await update($, warm, w => ({
    ...w,
    sent: 0,
    ...(isPaused && isEased ? { status: 'on' as const, pausedUntil: null } : {}),
  }))
  await update($, hold, h =>
    h.status === 'holding' || h.status === 'waiting' ? { ...h, status: 'armed' as const, resumeAt: null, pings: 0 } : h,
  )
}

// Their part of `turn.complete`, after telemetry's: whether the turn was a
// ping, so the voice leaves its "ok" unread. A ping's cost is kept, in dollars
// and in percent of the limit; a paused task starts its hold; a task the limit
// stopped anyway waits for the reset.
export async function warmTurnComplete($: EngineInterface, e: EventOf['turn.complete']): Promise<boolean> {
  if (e.agentId !== undefined) return false
  const s = { ...STATS, ...(await read($, stats)) }
  const w = { ...WARM, ...(await read($, warm)) }

  if (w.isPinging) {
    const moved = w.limitAtPing === null || s.limit === null ? null : Math.max(MIN_PING_PERCENT, s.limit - w.limitAtPing)
    await update($, warm, was => ({
      ...was,
      isPinging: false,
      limitAtPing: null,
      lastCost: s.turnCost,
      totalCost: was.totalCost + (s.turnCost ?? 0),
      pingPercent: moved ?? was.pingPercent,
    }))
    return true
  }

  const resumeAt = s.limitResetsAt === null ? null : s.limitResetsAt + RESUME_SLACK_MS
  const { status } = { ...HOLD, ...(await read($, hold)) }
  if (status === 'pausing') {
    await update($, hold, h => ({ ...h, status: 'holding' as const, resumeAt, pings: 0 }))
  } else if (status === 'armed' && e.reason === 'error' && (s.limit ?? 0) >= 99) {
    await update($, hold, h => ({ ...h, status: 'waiting' as const, resumeAt, pings: 0 }))
  }
  return false
}

// The shield's pause: while it pauses, Claude's tool calls are answered with
// the reason instead of run, so Claude stops between steps.
export function registerWarm(on: On): void {
  on('tool.call', async ($, e, next) => {
    if (({ ...HOLD, ...(await read($, hold)) }).status !== 'pausing' || OPEN_TOOLS.includes(e.tool)) return next(e)
    return { deny: PAUSE_REASON }
  }).catch(($, e, next) => next(e))
}
