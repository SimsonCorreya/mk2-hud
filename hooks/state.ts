// The starting value of every value the band reads. Each file that reads or
// writes one declares its own `atom` for it, with the same plugin and key, so
// `claude plugin validate` can see which values it touches; the starting
// values live here, once.

import type { Cache, Hold, HudSettings, Panel, Stats, VoicePlayer, Warm } from '../types'

export const IDLE: VoicePlayer = {
  status: 'idle',
  index: 0,
  total: 0,
  sentence: '',
  source: 'reply',
  envelope: '',
  durationMs: 0,
  offsetMs: 0,
  take: 0,
}

export const DEFAULTS: HudSettings = {
  speed: 1,
  voice: '',
  isAuto: false,
  mode: 'full',
  isCodeSkipped: true,
  isCollapsed: false,
  areOptionsShown: false,
  areCacheAlertsOn: true,
  areStatsShown: true,
  pronunciations: {},
  autoPronunciations: {},
  checkedWords: [],
  isLearningWords: true,
}

export const STATS: Stats = { turn: 0, speed: null, turnCost: null, total: 0, context: 0, costAtStart: 0, limit: null, limitResetsAt: null, weekLimit: null, weekResetsAt: null }
export const CACHE: Cache = { expiresAt: null, secondsLeft: null }
export const WARM: Warm = { status: 'off', sent: 0, isPinging: false, pausedUntil: null, lastCost: null, totalCost: 0, pingPercent: null, limitAtPing: null }
export const HOLD: Hold = { status: 'off', resumeAt: null, fallbackAt: 85, pings: 0 }
export const PANEL: Panel = { isCompact: false, isDoneCollapsed: false, autoOpenedFor: '' }
