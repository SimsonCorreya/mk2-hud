// The Cache & limit panel, beside the transcript like the agents panel: the
// prompt cache's countdown, the five-hour and weekly limits with their resets,
// and the 🔥 keep-warm and 🛡️ shield switches with what each does and is
// doing now. The band keeps its small cells and buttons for a glance.

import { atom, read } from 'claude-code'
import type { Register } from 'claude-code'

import { HUD, resetTime, xml } from './hud'
import { CACHE, HOLD, STATS, WARM } from './state'
import { cacheLevel } from './telemetry'
import { LIMITS_PANE, MAX_PINGS, pauseNow, setShield, setShieldAt, setWarm, triggerPoint } from './warm'

const cache = atom({ plugin: 'mk2-hud', key: 'cache' } as const, CACHE)
const hold = atom({ plugin: 'mk2-hud', key: 'hold' } as const, HOLD)
const isBusy = atom({ plugin: 'mk2-hud', key: 'isBusy' } as const, false)
const stats = atom({ plugin: 'mk2-hud', key: 'stats' } as const, STATS)
const warm = atom({ plugin: 'mk2-hud', key: 'warm' } as const, WARM)

type On = Parameters<Register>[0]

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const DAY_MS = 24 * 60 * 60 * 1000

// A reset within the day as a time, a later one with its weekday.
export const resetWhen = (at: number, now: number): string =>
  at - now < DAY_MS ? resetTime(at) : `${DAYS[new Date(at).getDay()] ?? ''} ${resetTime(at)}`

const until = (at: number | null, now: number): string => (at === null ? '' : ` ${resetWhen(at, now)}`)

const limitColor = (percent: number) => (percent >= 90 ? HUD.red : percent >= 70 ? HUD.orange : HUD.cyan)

// One meter as a drawing: a label, the value large, a note, and a bar.
export function gaugeSvg(label: string, value: string, note: string, fill: number, color: string): string {
  const W = 320
  const H = 52
  const barW = Math.max(3, Math.round(W * Math.min(1, Math.max(0, fill))))
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    `<style>text{font-family:Bahnschrift,'DIN Alternate','Segoe UI',sans-serif}.mono{font-family:'Cascadia Mono',Consolas,'SF Mono',monospace}</style>` +
    `<text x="0" y="11" font-size="9.5" letter-spacing="1.8" fill="${HUD.muted}">${xml(label.toUpperCase())}</text>` +
    `<text class="mono" x="0" y="35" font-size="22" font-weight="600" fill="${color}">${xml(value)}</text>` +
    `<text x="${W}" y="35" font-size="11.5" text-anchor="end" fill="${HUD.muted}">${xml(note)}</text>` +
    `<rect x="0" y="45" width="${W}" height="4" fill="#26333F"/>` +
    `<rect x="0" y="45" width="${barW}" height="4" fill="${color}"/>` +
    `</svg>`
  )
}

export function registerLimits(on: On): void {
  on('ui.render', { component: 'Pane', requestId: LIMITS_PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Button, Text } = ui
    // The terminal resolves Svg to an empty box: it gets the meters as text.
    const Svg = e.surface !== 'terminal' && 'Svg' in ui ? ui.Svg : undefined
    const s = { ...STATS, ...(await read($, stats)) }
    const w = { ...WARM, ...(await read($, warm)) }
    const shield = { ...HOLD, ...(await read($, hold)) }
    const { expiresAt, secondsLeft } = await read($, cache)
    const isWorking = await read($, isBusy)
    const now = await $.clock.now()

    const pad = (n: number) => String(n).padStart(2, '0')
    const cacheValue = isWorking
      ? 'in use'
      : secondsLeft === null
        ? '—'
        : secondsLeft === 0
          ? 'expired'
          : `${pad(Math.floor(secondsLeft / 60))}:${pad(secondsLeft % 60)}`
    const level = cacheLevel(secondsLeft, isWorking)
    const cacheNote = isWorking
      ? 'Claude is working: each answer restarts its hour'
      : secondsLeft === null
        ? 'starts with the first answer'
        : secondsLeft === 0
          ? 'the next message re-reads everything'
          : expiresAt === null
            ? ''
            : `expires ${resetTime(expiresAt)}`

    // A meter: the drawing where the surface has one, a line of text elsewhere.
    const meter = (key: string, label: string, value: string, note: string, fill: number, color: string) =>
      Svg !== undefined ? (
        <Box key={key} flexGrow={1} flexShrink={1} minWidth={0}>
          <Svg source={gaugeSvg(label, value, note, fill, color)} alt={`${label}: ${value}, ${note}`} />
        </Box>
      ) : (
        <Box key={key} flexDirection="row" flexWrap="wrap" columnGap="sm">
          <Text key="l" color={HUD.muted}>
            {label}
          </Text>
          <Text key="v" color={color} bold>
            {value}
          </Text>
          <Text key="n" color={HUD.muted}>
            {note}
          </Text>
        </Box>
      )
    const heading = (key: string, text: string) => (
      <Text key={key} color={HUD.cyan} weight="semibold">
        {text}
      </Text>
    )
    const about = (key: string, text: string) => (
      <Text key={key} size="footnote" color={HUD.muted}>
        {text}
      </Text>
    )
    const status = (key: string, text: string) => (
      <Text key={key} size="footnote" color={HUD.cyan}>
        {text}
      </Text>
    )

    // A note in its own colour: a warning in orange, the saving in gold.
    const note = (key: string, title: string, color: string, lines: string[]) => (
      <Box key={key} flexDirection="column" rowGap="xs">
        <Text key={`${key}-h`} color={color} weight="semibold">
          {title}
        </Text>
        {lines.map((line, at) => (
          <Text key={`${key}-${at}`} size="footnote" color={HUD.muted}>
            {line}
          </Text>
        ))}
      </Box>
    )

    const trigger = triggerPoint(s, w.pingPercent, shield.fallbackAt, now)
    const warmNow =
      w.status === 'off'
        ? 'Now: off.'
        : w.status === 'paused'
          ? `Now: paused near the limit${w.pausedUntil === null ? '' : `, until${until(w.pausedUntil, now)}`}; it carries on after your next message.`
          : `Now: on, ${w.sent} of ${MAX_PINGS} pings sent.`
    const shieldNow = {
      off: 'Now: off.',
      armed: `Now: armed. It pauses by itself at about ${trigger}% ${w.pingPercent === null ? '(the fixed point, until a ping has been measured)' : '(where what is left covers the wait)'}.`,
      pausing: 'Now: pausing. Claude stops at its next step.',
      holding: `Now: holding, ${shield.pings} ${shield.pings === 1 ? 'ping' : 'pings'} sent; "continue" goes out${shield.resumeAt === null ? ' after the reset' : ` at${until(shield.resumeAt, now)}`}.`,
      waiting: `Now: the limit was reached; "continue" goes out${shield.resumeAt === null ? ' after the reset' : ` at${until(shield.resumeAt, now)}`}.`,
    }[shield.status]
    const pingCosts =
      w.lastCost === null
        ? 'No ping sent yet.'
        : `Last ping: $${w.lastCost.toFixed(2)}${w.pingPercent === null ? '' : `, ${w.pingPercent.toFixed(1)}% of the limit`}. All pings: $${w.totalCost.toFixed(2)}.`

    return (
      <Box flexDirection="column" rowGap="md" paddingX={1} paddingY={1}>
        <Box key="cache" flexDirection="column" rowGap="xs">
          {heading('cache-h', 'PROMPT CACHE')}
          {meter('cache-m', 'Expires in', cacheValue, cacheNote, secondsLeft === null || isWorking ? (isWorking ? 1 : 0) : secondsLeft / 3600, level === 'alert' ? HUD.red : level === 'warn' ? HUD.orange : HUD.cyan)}
        </Box>

        <Box key="limits" flexDirection="column" rowGap="xs">
          {heading('limits-h', 'USAGE LIMITS')}
          {s.limit === null && s.weekLimit === null ? (
            about('limits-none', 'No reading yet: limits appear after the first answer, on a Claude subscription.')
          ) : (
            <Box key="limits-meters" flexDirection="column" rowGap="sm">
              {s.limit !== null &&
                meter('limit-5h', 'Session (5 hours)', `${Math.round(s.limit)}%`, s.limitResetsAt === null ? '' : `resets${until(s.limitResetsAt, now)}`, s.limit / 100, limitColor(s.limit))}
              {s.weekLimit !== null &&
                meter('limit-week', 'Weekly', `${Math.round(s.weekLimit)}%`, s.weekResetsAt === null ? '' : `resets${until(s.weekResetsAt, now)}`, s.weekLimit / 100, limitColor(s.weekLimit))}
            </Box>
          )}
        </Box>

        {note('usage-warning', '⚠ THESE USE YOUR LIMITS', HUD.orange, [
          '🔥 Keep warm and 🛡️ Shield send messages to Claude, so they use tokens and count toward your session and weekly limits. Each ping re-sends the whole conversation (at the cheaper cache rate), so in a long session one ping can take a percent or more of the limit. Use them with care.',
        ])}
        {note('usage-saving', '✦ WHY THEY CAN STILL SAVE', HUD.gold, [
          'Once the cache expires, your next message re-reads the whole conversation at full price, many times what a cached read costs. A ping costs only the cached rate, so it comes out cheaper whenever you would otherwise return to an expired cache; and 🛡️ also keeps a task from being cut off halfway.',
        ])}

        <Box key="warm" flexDirection="column" rowGap="xs">
          {heading('warm-h', '🔥 KEEP WARM')}
          <Box key="warm-controls" flexDirection="row" alignItems="center" columnGap="sm">
            {w.status === 'off' ? (
              <Button key="warm-on" variant="primary" label="Turn on" onPress={() => setWarm($, true)} />
            ) : (
              <Button key="warm-off" label="Turn off" onPress={() => setWarm($, false)} />
            )}
          </Box>
          {about(
            'warm-about',
            `While you're away, sends a one-word ping about 3 minutes before the cache expires, so your next message is cheap. Stops after ${MAX_PINGS} pings in a row, and pauses near the session limit.`,
          )}
          {status('warm-now', warmNow)}
          {about('warm-cost', pingCosts)}
        </Box>

        <Box key="shield" flexDirection="column" rowGap="xs">
          {heading('shield-h', '🛡️ SHIELD')}
          <Box key="shield-controls" flexDirection="row" flexWrap="wrap" alignItems="center" columnGap="sm" rowGap="xs">
            {shield.status === 'off' ? (
              <Button key="shield-on" variant="primary" label="Arm" onPress={() => setShield($, true)} />
            ) : (
              <Button key="shield-off" label="Turn off" onPress={() => setShield($, false)} />
            )}
            {(shield.status === 'off' || shield.status === 'armed') && (
              <Button key="shield-now" plain label="Pause now" onPress={() => pauseNow($)} />
            )}
            <Text key="shield-at-l" color={HUD.muted}>
              Fixed point
            </Text>
            <Button key="shield-at-down" plain label="−" onPress={() => setShieldAt($, shield.fallbackAt - 5)} />
            <Text key="shield-at" tabular>{`${shield.fallbackAt}%`}</Text>
            <Button key="shield-at-up" plain label="+" onPress={() => setShieldAt($, shield.fallbackAt + 5)} />
          </Box>
          {about(
            'shield-about',
            'For a task that won\'t finish in time: pauses it before the session limit runs out, pings to keep the cache warm while waiting, then sends "continue" once the limit resets. Armed, it pauses by itself where what is left just covers the wait (the fixed point until a ping has been measured).',
          )}
          {status('shield-now-text', shieldNow)}
        </Box>

        {note('usage-other', 'OTHER MK2-HUD FEATURES THAT USE TOKENS', HUD.muted, [
          '• Learn new words: unusual words in a reply are sent to Haiku to ask how to say them, a small request that counts toward your usage. Off in ⋯ → Learn new words, or /mk2-hud learn off.',
          '• Summary reading: Haiku condenses the reply before it is read, one small request each time. Read: Full reply in ⋯ uses none.',
          "• Plan reports: a short note in Claude's instructions asks it to report multi-step work to the mission row, adding a little to each request and a tool call per step. Off in the plugin's settings (Ask Claude to report its plans).",
        ])}
        {note('usage-free', '✓ FREE: RUNS ON YOUR COMPUTER ONLY', HUD.cyan, [
          'These use no tokens and never touch your session or weekly limits, only your computer:',
          '• Reading replies aloud: the voice runs on your machine, with every voice, speed and playback control.',
          '• Your pronunciation list (/mk2-hud say), and skipping or reading code blocks.',
          '• The helmet, the HUD and this panel.',
          '• The stats row: turn, speed, cost, context and the session-limit reading.',
          '• The cache countdown and its alerts.',
          '• The mission row and the agents panel, when they follow Claude\'s own task list and subagents.',
        ])}
      </Box>
    )
  })
}
