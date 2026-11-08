// The band above the prompt, "Suit Diagnostics": the helmet beside three rows.
//   1. Mission: the plan's steps as armour plates, and the agents button.
//   2. Telemetry: turn, speed, cost, cache and context, then ⋯ and ×.
//   3. Voice: the sentence being read, then Back, Pause, Next and Stop.
// ⋯ opens the settings tray inside the band, under the rows.

import { atom, read } from 'claude-code'
import type { Register } from 'claude-code'

import { HUD, missionSvg, resetTime, statsCells, statsSvg, voiceSvg } from './hud'
import { mascotSvg } from './mascot'
import { label as flowLabel, plannedOf, ratio, togglePane, viewOf } from './mission'
import { SPEEDS, formatSpeed, voiceLabel } from './speech-text'
import { CACHE, DEFAULTS, HOLD, IDLE, STATS, WARM } from './state'
import { cacheLevel } from './telemetry'
import {
  changeSettings,
  helmetOf,
  isReadingNow,
  playLast,
  setAuto,
  setSpeed,
  setVoice,
  skip,
  stepSpeed,
  stop,
  togglePause,
} from './voice'
import { MAX_PINGS, pressShield, toggleLimits, toggleWarm, triggerPoint } from './warm'

const agents = atom({ plugin: 'mk2-hud', key: 'agents' } as const, [])
const cache = atom({ plugin: 'mk2-hud', key: 'cache' } as const, CACHE)
const flow = atom({ plugin: 'mk2-hud', key: 'flow' } as const, null)
const player = atom({ plugin: 'mk2-hud', key: 'player' } as const, IDLE)
const settings = atom({ plugin: 'mk2-hud', key: 'settings' } as const, DEFAULTS)
const stats = atom({ plugin: 'mk2-hud', key: 'stats' } as const, STATS)
const voices = atom({ plugin: 'mk2-hud', key: 'voices' } as const, [])
const warm = atom({ plugin: 'mk2-hud', key: 'warm' } as const, WARM)
const hold = atom({ plugin: 'mk2-hud', key: 'hold' } as const, HOLD)

type On = Parameters<Register>[0]

// The tray's speeds: the common ones; /mk2-hud speed reaches the rest.
const TRAY_SPEEDS = [0.75, 1, 1.25, 1.5, 2] as const

// Rough pixels per reported column, and what each row's buttons take, so each
// row's drawing is drawn about as wide as what is left. The estimate is only a
// starting size: each drawing sits in a box that shrinks, and is scaled down to
// fit it, so a narrow, medium or wide transcript never pushes the buttons out.
const PX_PER_COLUMN = 8
const HELMET = 84
const AGENTS_BUTTON = 96
const MENU_BUTTONS = 100
const TRANSPORT = 190
const PLAY_BUTTON = 60

// The last width the band was drawn at, for `/mk2-hud width` while tuning.
let lastWidth = { columns: 0, inner: 0 }
export const bandWidth = () => lastWidth

const onOff = (isOn: boolean) => (isOn ? 'on' : 'off')
const ON_OFF = [
  { value: 'on', label: 'On' },
  { value: 'off', label: 'Off' },
]
const clock = (secondsLeft: number | null): string =>
  secondsLeft === null
    ? '—'
    : secondsLeft === 0
      ? 'expired'
      : `${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, '0')}`

export function registerBand(on: On): void {
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    const then = await read($, player)
    const chosen = await read($, settings)
    const voiceNames = await read($, voices)
    const s = { ...STATS, ...(await read($, stats)) }
    const { secondsLeft } = await read($, cache)
    const stored = await read($, flow)
    const runs = await read($, agents)
    const w = { ...WARM, ...(await read($, warm)) }
    // Keep-warm's toggle, always there: 🔥 alone while off; on, the pings
    // sent of the cap and the last one's cost; paused, until when.
    const isWarmShown = true
    const warmLabel =
      w.status === 'off'
        ? '🔥'
        : w.status === 'paused'
          ? `🔥 ⏸${w.pausedUntil !== null && w.pausedUntil > (await $.clock.now()) ? ` ${resetTime(w.pausedUntil)}` : ''}`
          : `🔥 ${w.sent}/${MAX_PINGS}${w.lastCost === null ? '' : ` · $${w.lastCost.toFixed(2)}`}`
    const onWarm = () => toggleWarm($)
    // The shield: dimmed off; armed, the point it pauses at; then pausing,
    // holding until "continue", or waiting out a limit that was hit anyway.
    const shield = { ...HOLD, ...(await read($, hold)) }
    const now = await $.clock.now()
    const untilTime = (when: number | null) => (when === null ? "" : ` ${resetTime(when)}`)
    const shieldLabel = {
      off: '🛡️',
      armed: `🛡️ ~${triggerPoint(s, w.pingPercent, shield.fallbackAt, now)}%`,
      pausing: '🛡️ pausing…',
      holding: `🛡️ ⏸${untilTime(shield.resumeAt)}`,
      waiting: `🛡️ ⏯${untilTime(shield.resumeAt)}`,
    }[shield.status]
    const onShield = () => pressShield($)
    const f = stored && viewOf(stored, runs)
    const crew = runs.length + plannedOf(f, runs).length
    const isReading = isReadingNow(then)
    const isPlaying = then.status === 'playing' || then.status === 'starting'
    const voice = voiceNames.includes(chosen.voice) ? chosen.voice : (voiceNames[0] ?? '')
    const level = cacheLevel(secondsLeft, e.props.isWorking)
    const isStatsRow = chosen.areStatsShown && s.turn > 0
    const playName = chosen.mode === 'summary' ? 'Read summary' : 'Read reply'
    const position = `${then.index + 1}/${then.total}`
    const onPlay = () => (then.status === 'idle' ? playLast($) : togglePause($))
    const toggleOptions = () => changeSettings($, was => ({ areOptionsShown: !was.areOptionsShown }))
    const collapse = (isCollapsed: boolean) => changeSettings($, () => ({ isCollapsed }))

    // The terminal draws no SVG: the same three rows in text.
    if (e.surface === 'terminal') {
      const { Box, Button, Text } = $.ui.resolve(e)
      const pauseLabel = then.status === 'paused' ? '▶ Resume' : '⏸ Pause'

      if (chosen.isCollapsed || e.props.hasSurvey) {
        return (
          <Box flexDirection="column">
            {below}
            <Box flexDirection="row" alignItems="center" columnGap="sm">
              <Text color={HUD.cyan}>◉ Mk2-HUD</Text>
              {isReading && <Button key="pause" hotkey="p" label={pauseLabel} onPress={() => togglePause($)} />}
              {isReading && <Text dimColor>{position}</Text>}
              {!e.props.hasSurvey && <Button key="expand" plain label="Show" onPress={() => collapse(false)} />}
            </Box>
          </Box>
        )
      }

      const barW = Math.max(6, Math.min(30, (e.props.bodyColumns || 80) - 40))
      const filled = f ? Math.round(barW * ratio(f)) : 0
      return (
        <Box flexDirection="column">
          {below}
          {f && (
            <Box flexDirection="row" columnGap={1}>
              <Text color={HUD.cyan}>◆</Text>
              <Text wrap="truncate-end">{f.title}</Text>
              <Text color={f.isFinished ? HUD.gold : HUD.cyan}>{'█'.repeat(filled) + '░'.repeat(barW - filled)}</Text>
              <Text bold>{flowLabel(f)}</Text>
              <Text dimColor>{`${Math.round(ratio(f) * 100)}%`}</Text>
              {crew > 0 && <Button key="agents" plain label={`agents ×${crew}`} onPress={() => togglePane($)} />}
            </Box>
          )}
          {isStatsRow && (
            <Box flexDirection="row" columnGap={2}>
              <Text dimColor>{`Turn ${s.turn}`}</Text>
              <Text>{s.speed === null ? '— tok/s' : `${s.speed} tok/s`}</Text>
              <Text color={HUD.gold}>{`$${(s.turnCost ?? 0).toFixed(2)} | $${s.total.toFixed(2)}`}</Text>
              <Text color={level === 'alert' ? HUD.red : level === 'warn' ? HUD.orange : HUD.cyan}>
                {`⧗ ${e.props.isWorking ? '…' : clock(secondsLeft)}`}
              </Text>
              <Text>{`ctx ${s.context}%`}</Text>
              {isWarmShown && <Button key="warm" hotkey="w" label={warmLabel} onPress={onWarm} />}
              <Button key="shield" label={shieldLabel} onPress={onShield} />
              <Button key="limits" label="⏱" onPress={() => toggleLimits($)} />
              {s.limit !== null && (
                <Text color={s.limit >= 90 ? HUD.red : s.limit >= 70 ? HUD.orange : undefined}>
                  {`limit ${Math.round(s.limit)}%${s.limitResetsAt === null ? '' : ` · resets ${resetTime(s.limitResetsAt)}`}`}
                </Text>
              )}
            </Box>
          )}
          <Box flexDirection="row" alignItems="center" columnGap="sm">
            {then.status === 'idle' && <Button key="play" hotkey="r" variant="primary" label={`▶ ${playName}`} onPress={onPlay} />}
            {isReading && <Button key="back" hotkey="b" label="⏮" onPress={() => skip($, -1)} />}
            {isReading && <Button key="pause" hotkey="p" variant="primary" label={pauseLabel} onPress={() => togglePause($)} />}
            {isReading && <Button key="next" hotkey="n" label="⏭" onPress={() => skip($, 1)} />}
            {then.status !== 'idle' && <Button key="stop" hotkey="s" label="⏹" onPress={() => stop($)} />}
            <Button key="slower" hotkey="d" label="−" onPress={() => setSpeed($, stepSpeed(chosen.speed, -1))} />
            <Text tabular>{formatSpeed(chosen.speed)}</Text>
            <Button key="faster" hotkey="f" label="+" onPress={() => setSpeed($, stepSpeed(chosen.speed, 1))} />
            <Button key="hide" dimColor label="Hide" onPress={() => collapse(true)} />
          </Box>
          {isReading && (
            <Text dimColor wrap="truncate-end">
              {`${position} · ${then.sentence}`}
            </Text>
          )}
        </Box>
      )
    }

    // Desktop, VS Code and the phone.
    const table = $.ui.resolve(e)
    const { Box, Button, Svg, Text } = table
    const Select = 'Select' in table ? table.Select : undefined
    const { mood, lip } = helmetOf(then, e.props.isWorking)
    // The clock the working animations keep their place by, across redraws.
    const at = mood === 'thinking' ? await $.clock.now() : 0
    // An image, not a frame: its CSS and SMIL animation run all the same, and
    // a new sentence swaps the picture without the frame reloading, which
    // blanked the helmet for a moment between sentences.
    const helmet = (size: number) => (
      <Svg source={mascotSvg(mood, lip, then.take, at)} alt={`Mk2-HUD helmet, ${mood}`} width={size} height={size} />
    )

    // A survey (the end-of-turn box among them) holds the band, and × folds
    // it: the helmet and its play button stay, since an auto-read starts then.
    if (chosen.isCollapsed || e.props.hasSurvey) {
      return (
        <Box flexDirection="column">
          {below}
          <Box flexDirection="row" alignItems="center" columnGap="sm">
            {helmet(36)}
            {then.status !== 'summarizing' && (
              <Button key="play" plain label={isPlaying ? '⏸' : '▶'} onPress={onPlay} />
            )}
            {isReading && (
              <Text size="footnote" dimColor tabular>
                {position}
              </Text>
            )}
            {!e.props.hasSurvey && <Button key="expand" plain dimColor label="Show HUD" onPress={() => collapse(false)} />}
          </Box>
        </Box>
      )
    }

    const inner = Math.max(320, Math.min(1600, (e.props.bodyColumns || 100) * PX_PER_COLUMN - 40)) - HELMET - 16
    lastWidth = { columns: e.props.bodyColumns, inner }
    // A drawing with no width of its own takes its markup's width up to its
    // slot; this box is that slot, and gives way to the buttons beside it.
    const fit = (key: string, art: ReturnType<typeof Svg>) => (
      <Box key={key} flexGrow={1} flexShrink={1} minWidth={0}>
        {art}
      </Box>
    )
    const menu = (
      <Box key="menu" flexDirection="row" alignItems="center" columnGap="xs" flexShrink={0}>
        <Button key="limits" plain label="⏱" onPress={() => toggleLimits($)} />
        {isWarmShown &&
          (w.status === 'on' ? (
            <Button key="warm" variant="primary" label={warmLabel} onPress={onWarm} />
          ) : (
            <Button key="warm" plain dimColor={w.status === 'off'} label={warmLabel} onPress={onWarm} />
          ))}
        {shield.status === 'off' ? (
          <Button key="shield" plain dimColor label={shieldLabel} onPress={onShield} />
        ) : (
          <Button key="shield" variant="primary" label={shieldLabel} onPress={onShield} />
        )}
        <Button key="options" plain label={chosen.areOptionsShown ? '⋯ ▴' : '⋯'} onPress={toggleOptions} />
        <Button key="hide" plain label="×" onPress={() => collapse(true)} />
      </Box>
    )

    const missionW = inner - (crew > 0 ? AGENTS_BUTTON : 0)
    const missionRow = f && (
      <Box key="mission" flexDirection="row" alignItems="center" columnGap="sm">
        {fit(
          'mission-art',
          <Svg source={missionSvg(f, missionW)} alt={`${f.title}: ${flowLabel(f)}, ${Math.round(ratio(f) * 100)}%`} />,
        )}
        {crew > 0 && <Button key="agents" plain label={`${crew} ${crew === 1 ? 'agent' : 'agents'}`} onPress={() => togglePane($)} />}
      </Box>
    )

    const statsW = inner - MENU_BUTTONS
    const statsRow = isStatsRow && (
      <Box key="stats" flexDirection="row" alignItems="center" columnGap="sm">
        {fit(
          'stats-art',
          <Svg
            source={statsSvg(statsCells(s, secondsLeft, level, e.props.isWorking), statsW)}
            alt={`Turn ${s.turn}, ${s.speed ?? '—'} tokens a second, $${(s.turnCost ?? 0).toFixed(2)} this turn of $${s.total.toFixed(2)}, cache ${clock(secondsLeft)}, context ${s.context}%${s.limit === null ? '' : `, session limit ${Math.round(s.limit)}% used${s.limitResetsAt === null ? '' : `, resets ${resetTime(s.limitResetsAt)}`}`}`}
          />,
        )}
        {menu}
      </Box>
    )

    const voiceW = inner - (then.status === 'idle' ? PLAY_BUTTON : TRANSPORT) - (isStatsRow ? 0 : MENU_BUTTONS)
    const voiceRow = (
      <Box key="voice" flexDirection="row" alignItems="center" columnGap="sm">
        {fit(
          'voice-art',
          <Svg
            source={voiceSvg({ player: then, speed: chosen.speed, isAuto: chosen.isAuto, mode: chosen.mode, hasVoices: voiceNames.length > 0 }, voiceW)}
            alt={isReading ? `Sentence ${position}: ${then.sentence}` : 'Voice on standby'}
          />,
        )}
        <Box key="transport" flexDirection="row" alignItems="center" columnGap="xs" flexShrink={0}>
          {/* The desktop draws a Button's label: the glyph itself. */}
          {isReading && <Button key="back" plain label="⏮" onPress={() => skip($, -1)} />}
          {then.status !== 'summarizing' && (
            <Button
              key="play"
              variant="primary"
              label={isPlaying ? '⏸' : '▶'}
              onPress={onPlay}
            />
          )}
          {isReading && <Button key="next" plain label="⏭" onPress={() => skip($, 1)} />}
          {then.status !== 'idle' && <Button key="stop" plain label="⏹" onPress={() => stop($)} />}
        </Box>
        {!isStatsRow && menu}
      </Box>
    )

    // The ⋯ tray: groups of settings, each a row of pickers, and a key to the
    // band's buttons. Keep-warm and the shield live in the Cache & limit panel.
    const pick = (
      key: string,
      name: string,
      value: string,
      choices: { value: string; label: string }[],
      onSelect: (picked: string) => unknown,
      cycle: () => unknown,
    ) =>
      Select !== undefined ? (
        <Select key={key} label={`${name} `} value={value} options={choices} onSelect={picked => void onSelect(picked)} />
      ) : (
        <Button key={key} plain label={`${name}: ${choices.find(c => c.value === value)?.label ?? value}`} onPress={() => void cycle()} />
      )
    const heading = (key: string, text: string) => (
      <Text key={key} color={HUD.cyan} weight="semibold">
        {text}
      </Text>
    )
    const speedChoices = [...new Set<number>([...TRAY_SPEEDS, chosen.speed])]
      .filter(speed => SPEEDS.some(one => one === speed))
      .sort((a, b) => a - b)
      .map(speed => ({ value: String(speed), label: formatSpeed(speed) }))

    const tray = chosen.areOptionsShown && (
      <Box key="tray" flexDirection="column" rowGap="sm" paddingTop={1}>
        <Box key="tray-voice" flexDirection="row" flexWrap="wrap" alignItems="center" columnGap="md" rowGap="xs">
          {heading('tray-voice-h', 'VOICE')}
          {pick('speed', 'Speed', String(chosen.speed), speedChoices, v => setSpeed($, Number(v)), () => setSpeed($, stepSpeed(chosen.speed, 1)))}
          {voiceNames.length > 1 ? (
            pick(
              'voice',
              'Voice',
              voice,
              voiceNames.map(name => ({ value: name, label: voiceLabel(name) })),
              v => setVoice($, v),
              () => setVoice($, voiceNames[(voiceNames.indexOf(voice) + 1) % voiceNames.length] ?? voice),
            )
          ) : (
            <Text key="voice" color={HUD.muted}>
              {voiceNames.length === 1 ? `Voice: ${voiceLabel(voice)}` : 'No voice installed: /mk2-hud voices'}
            </Text>
          )}
        </Box>
        <Box key="tray-reading" flexDirection="row" flexWrap="wrap" alignItems="center" columnGap="md" rowGap="xs">
          {heading('tray-reading-h', 'READING')}
          {pick(
            'mode',
            'Read',
            chosen.mode,
            [
              { value: 'full', label: 'Full reply' },
              { value: 'summary', label: 'Summary' },
            ],
            v => changeSettings($, () => ({ mode: v === 'summary' ? 'summary' : 'full' })),
            () => changeSettings($, was => ({ mode: was.mode === 'summary' ? 'full' : 'summary' })),
          )}
          {pick('auto', 'Auto-read', onOff(chosen.isAuto), ON_OFF, v => setAuto($, v === 'on'), () => setAuto($, !chosen.isAuto))}
          {pick(
            'code',
            'Code blocks',
            chosen.isCodeSkipped ? 'skip' : 'read',
            [
              { value: 'skip', label: 'Skip' },
              { value: 'read', label: 'Read aloud' },
            ],
            v => changeSettings($, () => ({ isCodeSkipped: v !== 'read' })),
            () => changeSettings($, was => ({ isCodeSkipped: !was.isCodeSkipped })),
          )}
          {pick(
            'learn',
            'Learn new words',
            onOff(chosen.isLearningWords),
            ON_OFF,
            v => changeSettings($, () => ({ isLearningWords: v === 'on' })),
            () => changeSettings($, was => ({ isLearningWords: !was.isLearningWords })),
          )}
        </Box>
        <Box key="tray-system" flexDirection="row" flexWrap="wrap" alignItems="center" columnGap="md" rowGap="xs">
          {heading('tray-system-h', 'SYSTEM')}
          {pick(
            'alerts',
            'Cache alerts',
            onOff(chosen.areCacheAlertsOn),
            ON_OFF,
            v => changeSettings($, () => ({ areCacheAlertsOn: v === 'on' })),
            () => changeSettings($, was => ({ areCacheAlertsOn: !was.areCacheAlertsOn })),
          )}
          {pick(
            'statsRow',
            'Session stats',
            onOff(chosen.areStatsShown),
            [
              { value: 'on', label: 'Shown' },
              { value: 'off', label: 'Hidden' },
            ],
            v => changeSettings($, () => ({ areStatsShown: v === 'on' })),
            () => changeSettings($, was => ({ areStatsShown: !was.areStatsShown })),
          )}
          <Button key="agentsPanel" plain label="Agents panel" onPress={() => togglePane($)} />
          <Button key="limitsPanel" plain label="⏱ Cache & limit panel" onPress={() => toggleLimits($)} />
        </Box>
        <Box key="tray-keys" flexDirection="column" rowGap="xs">
          <Text key="keys" color={HUD.muted}>
            {'⏮ ⏸/▶ ⏭ ⏹  back, pause or play, next, stop   ·   ⏱ cache & limit panel (explains 🔥 and 🛡️)   ·   🔥 keep warm   ·   🛡️ shield   ·   ⋯ these settings'}
          </Text>
        </Box>
      </Box>
    )

    return (
      <Box flexDirection="column">
        {below}
        <Box
          flexDirection="column"
          rowGap="sm"
          paddingX={1}
          paddingY={1}
        >
          <Box flexDirection="row" alignItems="center" columnGap="md">
            {helmet(HELMET)}
            <Box flexDirection="column" rowGap="sm" flexGrow={1} flexShrink={1} minWidth={0}>
              {missionRow}
              {statsRow}
              {voiceRow}
            </Box>
          </Box>
          {tray}
        </Box>
      </Box>
    )
  })
}
