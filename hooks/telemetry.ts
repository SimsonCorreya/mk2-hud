// Telemetry: turn number, output speed, turn and session cost, the prompt
// cache countdown and the context fill, with its macOS notifier. Taken from
// session-band (MIT, johnnyvizz).

import { atom, read, update } from 'claude-code'
import type { EngineInterface, EventOf, Register } from 'claude-code'

import { CACHE, DEFAULTS, STATS } from './state'
import { warmTurnStart } from './warm'

const cache = atom({ plugin: 'mk2-hud', key: 'cache' } as const, CACHE)
const isBusy = atom({ plugin: 'mk2-hud', key: 'isBusy' } as const, false)
const settings = atom({ plugin: 'mk2-hud', key: 'settings' } as const, DEFAULTS)
const stats = atom({ plugin: 'mk2-hud', key: 'stats' } as const, STATS)
const warned = atom({ plugin: 'mk2-hud', key: 'warned' } as const, 0)

type On = Parameters<Register>[0]

// Responses shorter than this are mostly tool-call stubs: their timing is noise.
const MIN_TOKENS = 20
// A response that arrived in one burst cannot be timed; such readings are dropped.
const MIN_SECONDS = 0.5
const MAX_SPEED = 1000

const CACHE_TTL_MS = 60 * 60 * 1000
export const CACHE_WARN_S = 20 * 60
export const CACHE_ALERT_S = 10 * 60
// Minutes left at which the cache expiry is announced, once each per answer.
const CACHE_NOTIFY_MINUTES = [10, 5] as const

export type CacheLevel = 'ok' | 'warn' | 'alert'

export const cacheLevel = (secondsLeft: number | null, isWorking: boolean): CacheLevel =>
  isWorking || secondsLeft === null
    ? 'ok'
    : secondsLeft <= CACHE_ALERT_S
      ? 'alert'
      : secondsLeft <= CACHE_WARN_S
        ? 'warn'
        : 'ok'

async function refresh($: EngineInterface) {
  const { cost, context, rateLimits } = await $.session.usage()
  const total = cost?.usd ?? 0
  // The five-hour window is the session limit; empty off a subscription.
  const session = rateLimits.find(limit => limit.kind === 'five_hour')
  const week = rateLimits.find(limit => limit.kind === 'seven_day')
  const resetsAt = session?.resetsAt === undefined ? NaN : Date.parse(session.resetsAt)
  const weekResetsAt = week?.resetsAt === undefined ? NaN : Date.parse(week.resetsAt)
  await update($, stats, s => ({
    ...s,
    total,
    turnCost: total - s.costAtStart,
    context: context.percent ?? s.context,
    limit: session?.percentUsed ?? s.limit,
    limitResetsAt: Number.isFinite(resetsAt) ? resetsAt : session === undefined ? s.limitResetsAt : null,
    weekLimit: week?.percentUsed ?? s.weekLimit,
    weekResetsAt: Number.isFinite(weekResetsAt) ? weekResetsAt : week === undefined ? s.weekResetsAt : null,
  }))
}

// Built by notifier/build.sh (macOS): posts the warning under the HUD's name.
const NOTIFIER = 'notifier/Mk2-HUD.app/Contents/MacOS/mk2-hud-notifier'
// The desktop app's id for a local Code session, as its claude:// links take it.
const HOST_SESSION = /^local_[A-Za-z0-9-]{1,64}$/

// This session as the desktop app knows it: its id and the title in its sidebar.
// Null outside the desktop app; the title null when its record cannot be read.
async function desktopSession($: EngineInterface) {
  const id = await $.env.get('CLAUDE_CODE_HOST_SESSION_ID')
  if (id === undefined || !HOST_SESSION.test(id)) return null

  const home = await $.env.get('HOME')
  const account = await $.env.get('CLAUDE_CODE_ACCOUNT_UUID')
  const org = await $.env.get('CLAUDE_CODE_ORGANIZATION_UUID')
  const record = `${home}/Library/Application Support/Claude/claude-code-sessions/${account}/${org}/${id}.json`
  const title = await $.fs.read(record).then(
    text => (JSON.parse(text) as { title?: unknown }).title,
    () => undefined,
  )

  return { id, title: typeof title === 'string' && title.trim() !== '' ? title.trim() : null }
}

// The notifier's system notification, titled with the project and the session,
// which opens this session when clicked. Without the notifier (not built, not
// macOS, or notifications not allowed), Claude Code's own notification, which
// also reaches the phone over Remote Control; it is skipped while the person is
// at this session, and then a toast says it instead.
async function notifyCacheExpiry($: EngineInterface, minutes: number) {
  const project = (await $.session.cwd()).split(/[\\/]/).filter(Boolean).pop() ?? 'session'
  const message = `Prompt cache expires in ${minutes} min`

  const notifier = `${$.plugin.root}/${NOTIFIER}`
  if (await $.fs.exists(notifier)) {
    const session = await desktopSession($)
    const argv = [
      notifier,
      '-title',
      session?.title ? `${project} — ${session.title}` : project,
      '-message',
      message,
      '-group',
      `mk2-hud-${session?.id ?? (await $.session.id())}`,
      ...(session ? ['-open', `claude://code/continue?session=${session.id}`] : []),
    ]
    // The first run waits while macOS asks whether to allow its notifications.
    const ran = await $.process.run(argv, { timeoutMs: 60_000 }).catch(() => null)
    if (ran?.exitCode === 0) return
  }

  const text = `${project}: ${message.charAt(0).toLowerCase()}${message.slice(1)}`
  const sent = await $.tool
    .call({ tool: 'PushNotification', message: text, status: 'proactive' })
    .catch(() => null)
  const isDelivered =
    sent !== null &&
    sent.deny === undefined &&
    sent.isError !== true &&
    (sent.result.pushSent === true || sent.result.localSent === true)

  if (!isDelivered) $.ui.toast(`⏳ ${text}`, { timeoutMs: 30000 })
}

// `/mk2-hud demo <minutes>` fakes the cache deadline to preview the warnings;
// the next answer resets it.
export async function demoCache($: EngineInterface, minutes: number): Promise<void> {
  const seconds = Math.round(minutes * 60)
  const at = await $.clock.now()
  await update($, cache, () => ({ expiresAt: at + seconds * 1000, secondsLeft: seconds }))
  await update($, warned, () => 0)
}

// Responses shorter than MIN_TOKENS, faster than MIN_SECONDS or above
// MAX_SPEED are not timed; register.tsx's `turn.step` hook asks this.
export const isTimeable = (tokens: number, seconds: number): boolean =>
  tokens >= MIN_TOKENS && seconds >= MIN_SECONDS && tokens / seconds <= MAX_SPEED

export async function recordSpeed($: EngineInterface, tokens: number, seconds: number): Promise<void> {
  if (isTimeable(tokens, seconds)) await update($, stats, s => ({ ...s, speed: Math.round(tokens / seconds) }))
}

export { refresh as refreshTelemetry }

// Telemetry's part of `session.start`, after the engine's own: the cache
// countdown and its warnings, once a second.
export function telemetrySessionStart($: EngineInterface): void {
  $.clock.every(1000, async () => {
      const { expiresAt } = await read($, cache)
      if (expiresAt === null) return

      const left = Math.max(0, Math.floor((expiresAt - (await $.clock.now())) / 1000))
      if (left !== (await read($, cache)).secondsLeft) {
        await update($, cache, c => ({ expiresAt: c.expiresAt ?? expiresAt, secondsLeft: left }))
      }

      const due = CACHE_NOTIFY_MINUTES.filter(m => left > 0 && left <= m * 60)
      if (due.length === 0 || (await read($, isBusy)) || !(await read($, settings)).areCacheAlertsOn) return

      const minutes = Math.min(...due)
      const last = await read($, warned)
      if (last !== 0 && last <= minutes) return

      await update($, warned, () => minutes)
      await notifyCacheExpiry($, Math.ceil(left / 60))
  })
}

// Telemetry's part of `turn.complete`, after the engine's own: the session's
// numbers, and the cache's hour starting over after an answer.
export async function telemetryTurnComplete($: EngineInterface, e: EventOf['turn.complete']): Promise<void> {
  await refresh($)

  if (e.agentId === undefined) {
    const at = await $.clock.now()
    await update($, cache, () => ({ expiresAt: at + CACHE_TTL_MS, secondsLeft: CACHE_TTL_MS / 1000 }))
    await update($, isBusy, () => false)
    await update($, warned, () => 0)
  }
}

export function registerTelemetry(on: On): void {
  on('turn.start', async ($, e, next) => {
    const total = (await $.session.usage()).cost?.usd ?? 0
    await update($, stats, s => ({ ...s, turn: s.turn + 1, costAtStart: total, total }))
    await update($, isBusy, () => true)
    await warmTurnStart($, e)

    return next(e)
  })
}
