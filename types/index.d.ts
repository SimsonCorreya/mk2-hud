// ---------------------------------------------------------------------------
// Voice: the reading aloud (from talk-to-me).

export type VoiceStatus = 'idle' | 'starting' | 'summarizing' | 'playing' | 'paused'

export type VoicePlayer = {
  status: VoiceStatus
  /** The sentence being read, from 0. */
  index: number
  total: number
  sentence: string
  /** Whether the reading is the reply itself or a spoken summary of it. */
  source: 'reply' | 'summary'
  /** The sentence's loudness, a digit 0-9 per 50 ms: what the helmet's mouth follows. */
  envelope: string
  durationMs: number
  /** Where in the sentence the voice was when it started or resumed. */
  offsetMs: number
  /** Counts starts, pauses and resumes, so the helmet's animation restarts with each. */
  take: number
}

export type HudSettings = {
  /** Playback speed as a multiple of normal (0.5 to 3). */
  speed: number
  /** The Piper voice's file name, without .onnx; '' is the first installed. */
  voice: string
  /** Read each new reply as soon as the turn ends. */
  isAuto: boolean
  mode: 'full' | 'summary'
  isCodeSkipped: boolean
  /** The band folded to the helmet and its play button. */
  isCollapsed: boolean
  /** The settings tray behind the ⋯ button. */
  areOptionsShown: boolean
  /** Notify before the prompt cache expires. */
  areCacheAlertsOn: boolean
  /** The row of turn, speed, cost, cache and context. */
  areStatsShown: boolean
  /**
   * How to say words the voice gets wrong, by the word in lower case:
   * `{ novakitai: 'nova kit A I' }`. Set with `/mark-2-hud say`.
   */
  pronunciations: Record<string, string>
  /**
   * Pronunciations Haiku suggested for unusual words in replies, keyed the
   * same way; the person's own `pronunciations` win over these.
   */
  autoPronunciations: Record<string, string>
  /** Words already put to Haiku, kept so none is asked about twice. */
  checkedWords: string[]
  /** Ask Haiku about unusual words before a reading. */
  isLearningWords: boolean
}

// ---------------------------------------------------------------------------
// Mission: the plan, Claude's task list and subagents (from savvy-progress).

export type Phase = 'plan' | 'design' | 'delegate' | 'review' | 'close'

export type PlannedTask = {
  title: string
  tier: string
  after: number[]
}

/**
 * What drives the mission row: `plan` the progress tool (Claude reporting its
 * own plan), `tasks` Claude's task list, `agents` subagents alone.
 */
export type FlowSource = 'plan' | 'tasks' | 'agents'

export type Flow = {
  title: string
  total: number
  done: number
  running: number
  phase: Phase
  isFinished: boolean
  tasks: PlannedTask[]
  source: FlowSource
  /** An `agents` flow counts the runs started from this moment on. */
  startedAt?: number
}

/** One entry of Claude's own task list, as TodoWrite or TaskCreate/TaskUpdate keep it. */
export type TaskItem = {
  id: string
  subject: string
  activeForm?: string
  status: 'pending' | 'in_progress' | 'completed'
}

export type AgentStatus = 'running' | 'done' | 'failed'

export type AgentRun = {
  id: string
  agentId?: string
  type: string
  description: string
  model: string
  effort?: string
  status: AgentStatus
  startedAt: number
  endedAt?: number
  contextTokens: number
  contextMax: number
  tokens: number
  costUsd: number
  steps: number
  round: number
  /** Self-reported by the worker through the `step` tool. */
  stepDone?: number
  stepTotal?: number
  stepNote?: string
}

export type Panel = {
  isCompact: boolean
  isDoneCollapsed: boolean
  autoOpenedFor: string
}

// ---------------------------------------------------------------------------
// Telemetry: the session's numbers (from session-band).

export type Stats = {
  turn: number
  speed: number | null
  turnCost: number | null
  total: number
  context: number
  costAtStart: number
  /** The five-hour session limit used, 0 to 100; null off a subscription or before a reading. */
  limit: number | null
  /** When that limit resets, in epoch milliseconds; null when unknown. */
  limitResetsAt: number | null
  /** The weekly limit used, 0 to 100; null off a subscription or before a reading. */
  weekLimit: number | null
  /** When the weekly limit resets, in epoch milliseconds; null when unknown. */
  weekResetsAt: number | null
}

/** Keep-warm: pings that keep the prompt cache from expiring while nobody types. */
export type Warm = {
  /** off; on (pinging when due); paused near a limit until the person's next message. */
  status: 'off' | 'on' | 'paused'
  /** Pings sent since the person last typed. */
  sent: number
  /** True from a ping's sending until its turn completes. */
  isPinging: boolean
  /** When the limit that paused it resets, in epoch milliseconds; null when unknown. */
  pausedUntil: number | null
  /** What the last ping cost, in dollars; null before the first. */
  lastCost: number | null
  /** What all pings this session cost, in dollars. */
  totalCost: number
  /** How much of the five-hour limit one ping was measured to use, in percent; null before one was. */
  pingPercent: number | null
  /** The limit when the ping in flight went out, to measure it by; null with none in flight. */
  limitAtPing: number | null
}

/** The shield: pauses a task before the session limit, holds the cache warm, then sends "continue". */
export type Hold = {
  /**
   * off; armed (pauses by itself at the trigger point); pausing (Claude's tool
   * calls are refused until its turn ends); holding (pinging until the reset);
   * waiting (the limit was hit anyway: no pings, "continue" after the reset).
   */
  status: 'off' | 'armed' | 'pausing' | 'holding' | 'waiting'
  /** When "continue" goes out, in epoch milliseconds; null when not holding or unknown. */
  resumeAt: number | null
  /** The limit, in percent, it pauses at until a ping has been measured. */
  fallbackAt: number
  /** Pings sent in this hold. */
  pings: number
}

export type Cache = {
  expiresAt: number | null
  secondsLeft: number | null
}

declare module 'claude-code' {
  interface PluginState {
    'mark-2-hud': {
      player: VoicePlayer
      settings: HudSettings
      voices: string[]
      lastAnswer: string
      flow: Flow | null
      taskList: TaskItem[]
      agents: AgentRun[]
      panel: Panel
      now: number
      stats: Stats
      cache: Cache
      isBusy: boolean
      warned: number
      warm: Warm
      hold: Hold
    }
  }
}
