// Mk2-HUD: one Iron Man-style HUD above the prompt, joining three mods.
//   voice.ts      reads replies aloud (from talk-to-me)
//   mission.tsx   the plan, task list, subagents and agents panel (from savvy-progress)
//   telemetry.ts  turn, speed, cost, cache and context (from session-band)
//   band.tsx      draws the band; hud.ts its rows; mascot.ts the helmet
// One command, /mk2-hud, steers all of it.

import type { Register } from 'claude-code'

import { bandWidth, registerBand } from './band'
import { missionSessionStart, missionSubagentStep, missionTurnComplete, registerMission, togglePane } from './mission'
import {
  demoCache,
  recordSpeed,
  refreshTelemetry,
  registerTelemetry,
  telemetrySessionStart,
  telemetryTurnComplete,
} from './telemetry'
import { changeSettings, registerVoice, sayCommand, voiceCommand, voiceSessionStart, voiceTurnComplete } from './voice'
import { registerLimits } from './limits'
import { MAX_PINGS, pauseNow, registerWarm, setShield, setShieldAt, setWarm, toggleLimits, warmSessionStart, warmTurnComplete } from './warm'

const HELP = [
  '/mk2-hud reads the last reply aloud. Also:',
  '/mk2-hud pause | resume | stop | next | back',
  '/mk2-hud faster | slower | speed 1.5',
  '/mk2-hud summary | full (what gets read)',
  '/mk2-hud auto on | off (read each new reply)',
  '/mk2-hud code on | off (read code blocks)',
  '/mk2-hud voices (list voices and how to add more)',
  '/mk2-hud say (list how words are pronounced); say novakitai = nova kit A I (add one); say novakitai = (remove it)',
  '/mk2-hud learn on | off (Haiku suggests how to say new unusual words)',
  '/mk2-hud agents (show or hide the agents panel)',
  '/mk2-hud limits (show or hide the Cache & limit panel: the cache, the session and weekly limits, 🔥 keep warm and 🛡️ shield)',
  '/mk2-hud stats on | off (the row of turn, speed, cost, cache and context)',
  '/mk2-hud alerts on | off (notify before the prompt cache expires)',
  `/mk2-hud warm on | off (🔥 keep the prompt cache warm while you are away: a one-word ping before it expires, at most ${MAX_PINGS} in a row, paused near the session limit)`,
  '/mk2-hud shield on | off | now | at 85 (🛡️ pause a task before the session limit, keep the cache warm until it resets, then "continue"; it pauses by itself where what is left just covers the wait, or at 85% until a ping has been measured)',
  '/mk2-hud show | hide (the whole HUD)',
  '/mk2-hud demo <minutes> (preview the cache warning)',
].join('\n')

export const register: Register = (on, options) => {
  registerVoice(on)
  registerTelemetry(on)
  registerMission(on, options)
  registerBand(on)
  registerWarm(on)
  registerLimits(on)

  // The engine takes one hook per event without a matcher from a mod, so the
  // events the three parts share are hooked here, once, each part in turn.
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await voiceSessionStart($)
    telemetrySessionStart($)
    await missionSessionStart($, options)
    warmSessionStart($)
    await $.command.register({
      name: 'mk2-hud',
      description: "Mk2-HUD HUD: read Claude's last reply aloud, or steer the voice, agents panel and stats",
      argumentHint: '[pause|stop|next|back|speed 1.5|summary|full|auto on|say word = how|agents|limits|stats off|warm on|shield on|show|hide|help]',
      immediate: true,
    })

    return started
  })

  on('turn.complete', async ($, e, next) => {
    await missionTurnComplete($, e)
    const result = await next(e)
    await telemetryTurnComplete($, e)
    // A keep-warm ping's "ok" is not read aloud, nor kept as the last reply.
    const isPing = await warmTurnComplete($, e)
    if (!isPing) await voiceTurnComplete($, e)

    return result
  })

  // A subagent's request feeds the agents panel; the main conversation's is
  // timed for the speed cell, from its first item (its envelope,
  // message_start), so time-to-first-token is left out but thinking that
  // streams hidden or in one late burst is still timed: output_tokens counts it.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) {
      const result = yield* next(e)
      await missionSubagentStep($, e, result)
      return result
    }

    let startedAt: number | null = null
    for await (const chunk of next(e)) {
      if (startedAt === null) startedAt = await $.clock.now()
      if (chunk.kind === 'stop' && chunk.usage !== null) {
        await recordSpeed($, chunk.usage.output_tokens, ((await $.clock.now()) - startedAt) / 1000)
      }
      yield chunk
    }
    await refreshTelemetry($)
  })

  on('command.run', { command: 'mk2-hud' }, async ($, e) => {
    // `say` keeps its words' case and spaces, so it is read before the rest.
    const say = /^say(?:\s+([\s\S]*))?$/i.exec(e.args.trim())
    if (say !== null) return { text: await sayCommand($, say[1] ?? '') }

    const [verb = '', value = ''] = e.args.trim().toLowerCase().split(/\s+/)
    const isOn = value === 'on' || value === ''

    const spoken = await voiceCommand($, verb, value)
    if (spoken !== undefined) return { text: spoken }

    switch (verb) {
      case 'limits': {
        const isOpen = await toggleLimits($)
        return { text: isOpen ? 'Cache & limit panel opened.' : 'Cache & limit panel closed.' }
      }
      case 'agents': {
        const isOpen = await togglePane($)
        return { text: isOpen ? 'Agents panel opened.' : 'Agents panel closed.' }
      }
      case 'stats':
        await changeSettings($, () => ({ areStatsShown: isOn }))
        return { text: isOn ? 'Session stats shown.' : 'Session stats hidden.' }
      case 'warm':
        await setWarm($, isOn)
        return { text: isOn ? `Keep warm on: a one-word ping goes out ~3 min before the cache expires, at most ${MAX_PINGS} in a row.` : 'Keep warm off.' }
      case 'shield': {
        if (value === 'now') {
          await pauseNow($)
          return { text: '🛡️ Pausing now.' }
        }
        if (value === 'at') {
          const percent = Number(e.args.trim().split(/\s+/)[2])
          if (!Number.isFinite(percent)) return { text: 'Give the percent, as in /mk2-hud shield at 85.' }
          await setShieldAt($, percent)
          return { text: `🛡️ Pauses at ${Math.round(Math.min(97, Math.max(50, percent)))}% until a ping has been measured.` }
        }
        await setShield($, isOn)
        return { text: isOn ? '🛡️ Shield armed: it pauses the task before the session limit, holds the cache warm, then sends "continue".' : '🛡️ Shield off.' }
      }
      case 'alerts':
        await changeSettings($, () => ({ areCacheAlertsOn: isOn }))
        return { text: isOn ? 'Cache alerts on.' : 'Cache alerts off.' }
      case 'show':
      case 'hide':
        await changeSettings($, () => ({ isCollapsed: verb === 'hide' }))
        return { text: verb === 'hide' ? 'HUD folded to the helmet.' : 'HUD shown.' }
      case 'demo': {
        const minutes = Number(value)
        if (!Number.isFinite(minutes) || minutes <= 0) return { text: 'Give the minutes left, as in /mk2-hud demo 8.' }
        await demoCache($, minutes)
        await changeSettings($, () => ({ isCollapsed: false }))
        return { text: `Cache demo: ${value} min left until the next answer resets it.` }
      }
      case 'width': {
        const { columns, inner } = bandWidth()
        return { text: columns === 0 ? 'The HUD has not been drawn yet.' : `HUD: ${columns} columns, ${inner} px for the rows beside the helmet.` }
      }
      default:
        return { text: HELP }
    }
  })
}
