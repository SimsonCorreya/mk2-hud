// The voice: reads Claude's replies aloud with a Piper neural voice, through
// scripts/speaker.py. Taken from talk-to-me, its logic unchanged; the drawing
// lives in band.tsx.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, EventOf, Register } from 'claude-code'

import type { HudSettings, VoicePlayer } from '../types'
import type { Lip, Mood } from './mascot'
import { SPEEDS, formatSpeed, toSentences, unusualWords, voiceLabel } from './speech-text'
import { DEFAULTS, IDLE } from './state'

const lastAnswer = atom({ plugin: 'mark-2-hud', key: 'lastAnswer' } as const, '')
const player = atom({ plugin: 'mark-2-hud', key: 'player' } as const, IDLE)
const settings = atom({ plugin: 'mark-2-hud', key: 'settings' } as const, DEFAULTS)
const voices = atom({ plugin: 'mark-2-hud', key: 'voices' } as const, [])

type On = Parameters<Register>[0]

// What scripts/speaker.py polls to steer playback (see the script's header).
type Control = {
  reading: string
  paused: boolean
  speed: number
  volume: number
  voice: string
  seek: number
  seekSeq: number
  stop: boolean
  quit: boolean
}

type Paths = { separator: string; work: string; voices: string; uv: string; script: string }

const SUMMARY_SYSTEM = [
  "You turn an AI coding assistant's reply into a short summary that will be read aloud",
  'to someone who is listening rather than reading.',
  'Write 2 to 5 plain sentences: no Markdown, lists, code, URLs or file paths.',
  'Keep what was done or found, anything that failed, and any question or action the reply',
  'leaves for the listener. Speak to the listener as "you". Reply with the summary alone.',
].join(' ')

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export function toSettings(stored: unknown): HudSettings {
  const value = typeof stored === 'object' && stored !== null ? (stored as Partial<HudSettings>) : {}

  return {
    speed: SPEEDS.some(speed => speed === value.speed) ? (value.speed as number) : DEFAULTS.speed,
    voice: typeof value.voice === 'string' ? value.voice : DEFAULTS.voice,
    isAuto: value.isAuto === true,
    mode: value.mode === 'summary' ? 'summary' : 'full',
    isCodeSkipped: value.isCodeSkipped !== false,
    isCollapsed: value.isCollapsed === true,
    areOptionsShown: value.areOptionsShown === true,
    areCacheAlertsOn: value.areCacheAlertsOn !== false,
    areStatsShown: value.areStatsShown !== false,
    pronunciations: toPronunciations(value.pronunciations),
    autoPronunciations: toPronunciations(value.autoPronunciations),
    checkedWords: Array.isArray(value.checkedWords)
      ? value.checkedWords.filter((word): word is string => typeof word === 'string').map(word => word.toLowerCase())
      : [],
    isLearningWords: value.isLearningWords !== false,
  }
}

// Keeps the entries that are a word and a way to say it, keyed in lower case.
function toPronunciations(stored: unknown): Record<string, string> {
  if (typeof stored !== 'object' || stored === null) return {}
  const kept: Record<string, string> = {}
  for (const [word, said] of Object.entries(stored)) {
    if (typeof said === 'string' && said.trim() !== '' && /^[\p{L}\p{N}'-]+$/u.test(word)) kept[word.toLowerCase()] = said.trim()
  }

  return kept
}

export function stepSpeed(speed: number, step: 1 | -1): number {
  const at = SPEEDS.findIndex(one => one === speed)
  const next = SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, (at < 0 ? 2 : at) + step))]

  return next ?? speed
}

// Module state: a reload starts it over, and the speaker of the old load dies with it.
let paths: Paths | undefined
// Names this module load's control file; the speaker it starts lives as long.
let session = ''
let control: Control = {
  reading: '',
  paused: false,
  speed: 1,
  volume: 100,
  voice: '',
  seek: 0,
  seekSeq: 0,
  stop: true,
  quit: false,
}
let speaker: 'off' | 'starting' | 'ready' = 'off'
// The sentences of the reading `control.reading` names.
let sentences: string[] = []
// Bumped by every play and stop, so a summary that comes back late is dropped.
let generation = 0

export const voicesFolder = (): string => paths?.voices ?? 'the voices folder'

export async function changeSettings(
  $: EngineInterface,
  change: (current: HudSettings) => Partial<HudSettings>,
): Promise<HudSettings> {
  await update($, settings, current => ({ ...current, ...change(current) }))
  const saved = await read($, settings)
  await $.store.set('settings', saved)

  return saved
}

// Updates the control, and the file the speaker polls when one is running
// (`ensureSpeaker` writes it before it starts one).
async function steer($: EngineInterface, change: Partial<Control>) {
  control = { ...control, ...change }
  if (paths !== undefined && speaker !== 'off') {
    await $.fs.write(`${paths.work}${paths.separator}${session}.ctl.json`, JSON.stringify(control))
  }
}

export async function loadVoices($: EngineInterface): Promise<string[]> {
  const entries = paths === undefined ? [] : await $.fs.list(paths.voices).catch(() => [])
  const names = entries
    .map(entry => entry.name)
    .filter(name => name.endsWith('.onnx'))
    .map(name => name.slice(0, -'.onnx'.length))
    .sort()
  await update($, voices, () => names)

  return names
}

// The Python of the speaker script's own uv environment, made on first use.
async function findPython($: EngineInterface, where: Paths): Promise<string> {
  const uv = (await $.fs.exists(where.uv)) ? where.uv : 'uv'
  const find = () =>
    $.process.run([uv, 'python', 'find', '--no-python-downloads', '--script', where.script], { timeoutMs: 60_000 })
  let found = await find()
  // With no environment for the script yet (first run, or the mod moved), uv
  // answers with whatever Python it finds instead, one without Piper: an
  // environment of the script's own lives under uv's `environments` folder.
  if (found.exitCode !== 0 || !/environments/i.test(found.stdout)) {
    $.ui.toast('Setting up the Piper voice engine. This happens once and takes a minute.')
    const synced = await $.process.run([uv, 'sync', '--no-python-downloads', '--script', where.script], {
      timeoutMs: 600_000,
    })
    if (synced.exitCode !== 0) throw new Error(synced.stderr.trim().split('\n').slice(-3).join(' '))
    found = await find()
  }
  if (found.exitCode !== 0) throw new Error(found.stderr.trim())

  return found.stdout.trim()
}

async function onLine($: EngineInterface, line: string) {
  const [word = '', reading = '', ...rest] = line.split(' ')
  const isCurrent = reading === control.reading

  if (word === 'READY') {
    speaker = 'ready'
  } else if (word === 'START' && isCurrent) {
    const [index = 0, durationMs = 0, offsetMs = 0] = rest.slice(0, 3).map(Number)
    await update($, player, (then): VoicePlayer => ({
      ...then,
      status: control.paused ? 'paused' : 'playing',
      index,
      sentence: sentences[index] ?? '',
      envelope: rest[3] ?? '',
      durationMs,
      offsetMs,
      take: then.take + 1,
    }))
  } else if ((word === 'PAUSED' || word === 'RESUMED') && isCurrent) {
    await update($, player, (then): VoicePlayer => ({
      ...then,
      status: word === 'PAUSED' ? 'paused' : 'playing',
      offsetMs: Number(rest[0]) || 0,
      take: then.take + 1,
    }))
  } else if (word === 'END' && isCurrent) {
    await update($, player, () => IDLE)
  } else if (word === 'ERR') {
    $.ui.toast(`Mark-2 HUD voice: ${line.slice(4)}`)
  }
}

// Runs the speaker for the rest of the session (it quits by itself after 20
// idle minutes) and mirrors its progress into `player`.
async function runSpeaker($: EngineInterface, python: string, where: Paths) {
  let pending = ''
  try {
    const speech = $.process.spawn({
      argv: [
        python,
        where.script,
        '--dir',
        where.work,
        '--session',
        session,
        '--voices',
        where.voices,
        '--default-voice',
        (await read($, settings)).voice,
      ],
    })
    for await (const { stream, text } of speech) {
      if (stream === 'stderr') {
        $.ui.log(`mark-2-hud speaker: ${text}`, { to: 'debug' })
        continue
      }
      pending += text
      const lines = pending.split(/\r?\n/)
      pending = lines.pop() ?? ''
      for (const line of lines) await onLine($, line.trim())
    }
  } catch (error) {
    $.ui.toast(`Mark-2 HUD could not start the Piper voice: ${errorText(error)}`)
  } finally {
    speaker = 'off'
    await update($, player, () => IDLE)
  }
}

export async function ensureSpeaker($: EngineInterface) {
  const where = paths
  if (speaker !== 'off' || where === undefined) return
  speaker = 'starting'
  try {
    const python = await findPython($, where)
    await steer($, {})
    void runSpeaker($, python, where)
  } catch (error) {
    speaker = 'off'
    await update($, player, () => IDLE)
    $.ui.toast(`Mark-2 HUD needs uv and Piper: ${errorText(error)}`)
  }
}

export async function stop($: EngineInterface) {
  generation += 1
  if (!control.stop) await steer($, { stop: true })
  await update($, player, () => IDLE)
}

async function summarize($: EngineInterface, text: string): Promise<string | undefined> {
  try {
    const result = await $.model.complete({
      model: 'haiku',
      system: SUMMARY_SYSTEM,
      prompt: text.slice(0, 40_000),
      maxTokens: 400,
    })

    return result.isAnswered && result.text.trim() !== '' ? result.text : undefined
  } catch {
    return undefined
  }
}

// The words the voice says differently: Haiku's suggestions, then the
// person's own, which win.
export function spokenWords(chosen: HudSettings): Record<string, string> {
  return { ...chosen.autoPronunciations, ...chosen.pronunciations }
}

const LEARN_SYSTEM = [
  'You help a text-to-speech voice (Piper, with espeak-ng pronunciation rules for US English) say words it would get wrong.',
  'You get a JSON list of words, each with the sentence it appears in.',
  'For each word decide whether an English text-to-speech voice reading it letter for letter by English rules would say it wrongly:',
  'made-up names, brand names run together, product names, mixed letters and digits, foreign words.',
  'If it would, give a respelling the voice will say right, using plain English words and syllables separated by spaces,',
  'with capital letters for letters spelled out (for example "novakitai" becomes "nova kit A I", "Supabase" becomes "soopa base", "gpt4o" becomes "G P T four oh").',
  'If an ordinary English voice says it fine, give null.',
  'Reply with one JSON object and nothing else: {"<word>": "<respelling>" or null, ...}, every word given as a key.',
].join(' ')

// The longest Haiku may take before the reading goes ahead without it.
const LEARN_TIMEOUT_MS = 2500
// How many checked words are remembered; the oldest go first.
const CHECKED_KEEP = 3000

// Asks Haiku how to say the reply's new unusual words and keeps its answers.
// True when it added a pronunciation. A failed or slow call adds nothing and
// marks nothing checked, so those words are asked about next time.
async function learnWords($: EngineInterface, sentences: readonly string[], chosen: HudSettings): Promise<boolean> {
  const known = new Set([
    ...chosen.checkedWords,
    ...Object.keys(chosen.pronunciations),
    ...Object.keys(chosen.autoPronunciations),
  ])
  const words = unusualWords(sentences, known)
  if (words.length === 0) return false

  let answer: Record<string, unknown>
  try {
    const result = await $.model.complete({
      model: 'haiku',
      system: LEARN_SYSTEM,
      prompt: JSON.stringify(words.map(({ word, sentence }) => ({ word, sentence: sentence.slice(0, 300) }))),
      maxTokens: 600,
      timeoutMs: LEARN_TIMEOUT_MS,
    })
    const json = result.isAnswered ? /\{[\s\S]*\}/.exec(result.text)?.[0] : undefined
    if (json === undefined) return false
    answer = JSON.parse(json) as Record<string, unknown>
  } catch {
    return false
  }

  const learned: Record<string, string> = {}
  for (const { word } of words) {
    const said = answer[word] ?? answer[word.toLowerCase()]
    // A respelling is words, letters and hyphens, not another reply.
    if (typeof said === 'string' && /^[\p{L}\p{N}' -]{1,60}$/u.test(said.trim()) && said.trim().toLowerCase() !== word.toLowerCase()) {
      learned[word.toLowerCase()] = said.trim()
    }
  }
  const checked = words.map(({ word }) => word.toLowerCase())
  await changeSettings($, then => ({
    autoPronunciations: { ...then.autoPronunciations, ...learned },
    checkedWords: [...then.checkedWords.filter(word => !checked.includes(word)), ...checked].slice(-CHECKED_KEEP),
  }))

  return Object.keys(learned).length > 0
}

export async function play($: EngineInterface, text: string) {
  generation += 1
  const ticket = generation
  const where = paths
  if (where === undefined) return
  if ((await read($, voices)).length === 0 && (await loadVoices($)).length === 0) {
    $.ui.toast(`No Piper voices in ${where.voices}. Run /mark-2-hud voices to see how to add one.`)

    return
  }

  const chosen = await read($, settings)
  let spoken = text
  let source: VoicePlayer['source'] = 'reply'
  if (chosen.mode === 'summary') {
    await update($, player, () => ({ ...IDLE, status: 'summarizing', source: 'summary' }))
    const summary = await summarize($, text)
    if (ticket !== generation) return
    if (summary === undefined) {
      $.ui.toast('Could not summarize that reply, so reading it in full.')
    } else {
      spoken = summary
      source = 'summary'
    }
  }

  const say = (words: HudSettings) =>
    toSentences(spoken, { isCodeSkipped: words.isCodeSkipped, pronunciations: spokenWords(words) })
  let next = say(chosen)
  // New unusual words are put to Haiku first, so this reading already says them right.
  if (chosen.isLearningWords && next.length > 0) {
    await update($, player, () => ({ ...IDLE, status: 'starting', total: next.length, sentence: next[0] ?? '', source }))
    const learned = await learnWords($, next, chosen)
    if (ticket !== generation) return
    if (learned) next = say(await read($, settings))
  }
  if (next.length === 0) {
    await update($, player, () => IDLE)
    $.ui.toast('Nothing to read aloud in that reply.')

    return
  }
  const reading = `reading-${await $.clock.now()}`
  await $.fs.write(`${where.work}${where.separator}${reading}.txt`, next.join('\n'))
  if (ticket !== generation) return

  sentences = next
  await update($, player, () => ({ ...IDLE, status: 'starting', total: next.length, sentence: next[0] ?? '', source }))
  await steer($, {
    reading,
    paused: false,
    stop: false,
    speed: chosen.speed,
    voice: chosen.voice,
    seek: 0,
    seekSeq: control.seekSeq + 1,
  })
  await ensureSpeaker($)
}

// The reply this session last finished with; after a resume, the transcript's.
async function lastReply($: EngineInterface): Promise<string> {
  const kept = await read($, lastAnswer)
  if (kept.trim() !== '') return kept
  const rows = await $.session.messages()
  for (let at = rows.length - 1; at >= 0; at -= 1) {
    const row = rows[at]
    if (row?.role === 'assistant' && row.text.trim() !== '') return row.text
  }

  return ''
}

export async function playLast($: EngineInterface) {
  const text = await lastReply($)
  if (text === '') {
    $.ui.toast('There is no reply to read yet.')

    return
  }
  await play($, text)
}

export async function setPaused($: EngineInterface, isPaused: boolean) {
  const then = await read($, player)
  if (then.status === 'idle' || then.status === 'summarizing') return
  await steer($, { paused: isPaused })
  await update($, player, (was): VoicePlayer => ({
    ...was,
    status: isPaused ? 'paused' : was.status === 'starting' ? 'starting' : 'playing',
  }))
}

export async function togglePause($: EngineInterface) {
  const then = await read($, player)
  if (then.status === 'idle') return playLast($)
  await setPaused($, !control.paused)
}

// Moves by whole sentences; past the last one the reading ends.
export async function skip($: EngineInterface, step: 1 | -1) {
  const then = await read($, player)
  if (then.status === 'idle' || then.status === 'summarizing') return
  const index = Math.max(0, Math.min(sentences.length, then.index + step))
  await steer($, { seek: index, seekSeq: control.seekSeq + 1 })
  if (index < sentences.length) {
    await update($, player, was => ({ ...was, index, sentence: sentences[index] ?? '' }))
  }
}

export async function setSpeed($: EngineInterface, speed: number) {
  const saved = await changeSettings($, () => ({ speed }))
  await steer($, { speed: saved.speed })
}

export async function setVoice($: EngineInterface, voice: string) {
  await changeSettings($, () => ({ voice }))
  await steer($, { voice })
}

export async function setAuto($: EngineInterface, isAuto: boolean) {
  await changeSettings($, () => ({ isAuto }))
  if (isAuto && (await read($, voices)).length > 0) void ensureSpeaker($)
}

export const isReadingNow = (then: VoicePlayer): boolean =>
  then.status === 'starting' || then.status === 'playing' || then.status === 'paused'

// The helmet's mood and lips for the player's state; `isWorking` (Claude
// writing a reply) shows as thinking when nothing is being read.
export function helmetOf(then: VoicePlayer, isWorking: boolean): { mood: Mood; lip: Lip | undefined } {
  const mood: Mood =
    then.status === 'playing'
      ? 'talking'
      : then.status === 'paused'
        ? 'paused'
        : then.status === 'idle'
          ? isWorking
            ? 'thinking'
            : 'idle'
          : 'thinking'
  const lip: Lip | undefined =
    isReadingNow(then) && then.envelope !== ''
      ? { envelope: then.envelope, durationMs: then.durationMs, offsetMs: then.offsetMs }
      : undefined

  return { mood, lip }
}

// `/mark-2-hud say` lists the pronunciations, the person's and Haiku's; `say <word>
// = <how>` sets one as the person's own, `say <word> =` has the word read as
// written. Either way Haiku's suggestion for it goes and it is not asked again.
export async function sayCommand($: EngineInterface, args: string): Promise<string> {
  const chosen = await read($, settings)
  const text = args.trim()
  if (text === '') {
    const yours = Object.entries(chosen.pronunciations)
    const learned = Object.entries(chosen.autoPronunciations)
    if (yours.length === 0 && learned.length === 0) {
      return chosen.isLearningWords
        ? 'No pronunciations yet. Haiku adds them as replies bring new words; set one yourself with /mark-2-hud say novakitai = nova kit A I'
        : 'No pronunciations yet. Add one with /mark-2-hud say novakitai = nova kit A I'
    }
    const list = (entries: [string, string][]) => entries.map(([word, said]) => `  ${word} = ${said}`)

    return [
      ...(yours.length > 0 ? ['Yours:', ...list(yours)] : []),
      ...(learned.length > 0 ? ['Learned by Haiku (change or remove any with /mark-2-hud say):', ...list(learned)] : []),
      chosen.isLearningWords ? '' : 'Learning new words is off: /mark-2-hud learn on',
    ]
      .filter(line => line !== '')
      .join('\n')
  }

  const match = /^([\p{L}\p{N}'-]+)\s*(?:=\s*(.*))?$/u.exec(text)
  if (match === null) return 'Write it as /mark-2-hud say <word> = <how to say it>, one word at a time.'
  const word = (match[1] ?? '').toLowerCase()
  const said = (match[2] ?? '').trim()
  if (match[2] === undefined) {
    const own = chosen.pronunciations[word]
    const learned = chosen.autoPronunciations[word]
    return own !== undefined ? `${word} = ${own}` : learned !== undefined ? `${word} = ${learned} (learned by Haiku)` : `"${word}" has no pronunciation set.`
  }
  // The word leaves Haiku's list and is marked checked, so Haiku never sets it again.
  const settle = (then: HudSettings) => {
    const { [word]: _learned, ...autoPronunciations } = then.autoPronunciations
    const checkedWords = then.checkedWords.includes(word) ? then.checkedWords : [...then.checkedWords, word].slice(-CHECKED_KEEP)
    return { autoPronunciations, checkedWords }
  }
  if (said === '') {
    await changeSettings($, then => {
      const { [word]: _own, ...pronunciations } = then.pronunciations
      return { ...settle(then), pronunciations }
    })
    return `"${word}" will be read as written.`
  }
  await changeSettings($, then => ({ ...settle(then), pronunciations: { ...then.pronunciations, [word]: said } }))

  return `"${word}" will be read as "${said}".`
}

// `/mark-2-hud <verb> <value>` for the voice; undefined when the verb is not one.
export async function voiceCommand($: EngineInterface, verb: string, value: string): Promise<string | undefined> {
  const isOn = value === 'on' || value === ''

  switch (verb) {
    case '':
    case 'read':
    case 'play':
      await playLast($)
      return 'Reading the last reply aloud.'
    case 'pause':
    case 'resume':
      await setPaused($, verb === 'pause')
      return verb === 'pause' ? 'Paused.' : 'Resumed.'
    case 'stop':
      await stop($)
      return 'Stopped reading.'
    case 'next':
    case 'back':
      await skip($, verb === 'next' ? 1 : -1)
      return verb === 'next' ? 'Skipped ahead a sentence.' : 'Went back a sentence.'
    case 'faster':
    case 'slower': {
      const { speed } = await read($, settings)
      await setSpeed($, stepSpeed(speed, verb === 'faster' ? 1 : -1))
      return `Speed ${formatSpeed((await read($, settings)).speed)}.`
    }
    case 'speed': {
      const wanted = Number(value.replace(/[x×]$/, ''))
      const nearest = [...SPEEDS].sort((a, b) => Math.abs(a - wanted) - Math.abs(b - wanted))[0]
      if (value === '' || !Number.isFinite(wanted) || nearest === undefined) {
        return `Speeds: ${SPEEDS.map(formatSpeed).join(', ')}.`
      }
      await setSpeed($, nearest)
      return `Speed ${formatSpeed(nearest)}.`
    }
    case 'summary':
    case 'full':
      await changeSettings($, () => ({ mode: verb }))
      return verb === 'summary' ? 'Replies will be read as a short summary.' : 'Replies will be read in full.'
    case 'auto':
      await setAuto($, isOn)
      return isOn ? 'Each new reply will be read aloud.' : 'Auto-read is off.'
    case 'code':
      await changeSettings($, () => ({ isCodeSkipped: !isOn }))
      return isOn ? 'Code blocks will be read.' : 'Code blocks will be skipped.'
    case 'learn':
      await changeSettings($, () => ({ isLearningWords: isOn }))
      return isOn
        ? 'Haiku will suggest how to say new unusual words before each reading. See them with /mark-2-hud say.'
        : 'New words are no longer put to Haiku; the pronunciations already learned stay.'
    case 'voices': {
      const names = await loadVoices($)
      const listed = names.length === 0 ? 'No voices are installed.' : `Installed: ${names.map(voiceLabel).join(', ')}.`
      return [
        listed,
        `Voices live in ${voicesFolder()}.`,
        'To add one, download its .onnx and .onnx.json files from',
        'https://huggingface.co/rhasspy/piper-voices into that folder, then run /mark-2-hud voices again.',
      ].join('\n')
    }
    default:
      return undefined
  }
}

// The voice's part of `session.start`, after the engine's own: where its files
// live, the stored settings, and the voices installed.
export async function voiceSessionStart($: EngineInterface): Promise<void> {
  session = `session-${await $.clock.now()}`
  const localAppData = await $.env.get('LOCALAPPDATA')
  // The work and voices folders are talk-to-me's, shared on purpose: the
  // voices are installed once, and every speaker takes turns through the
  // same lock file in the work folder.
  if (localAppData !== undefined) {
    const temp = (await $.env.get('TEMP')) ?? localAppData
    const profile = (await $.env.get('USERPROFILE')) ?? ''
    paths = {
      separator: '\\',
      work: `${temp}\\claude-read-aloud`,
      voices: `${localAppData}\\claude-read-aloud\\voices`,
      uv: `${profile}\\.local\\bin\\uv.exe`,
      script: `${$.plugin.root}\\scripts\\speaker.py`,
    }
  } else {
    const home = (await $.env.get('HOME')) ?? ''
    const temp = ((await $.env.get('TMPDIR')) ?? '/tmp').replace(/\/$/, '')
    paths = {
      separator: '/',
      work: `${temp}/claude-read-aloud`,
      voices: `${home}/.local/share/claude-read-aloud/voices`,
      uv: `${home}/.local/bin/uv`,
      script: `${$.plugin.root}/scripts/speaker.py`,
    }
  }

  const stored = toSettings(await $.store.get('settings'))
  await update($, settings, () => stored)
  await update($, player, () => IDLE)
  // With auto-read on, load the voice now so the first reply starts at once.
  const names = await loadVoices($)
  if (stored.isAuto && names.length > 0) void ensureSpeaker($)
}

// The voice's part of `turn.complete`, after the engine's own: keep the
// reply, and read it when auto-read is on.
export async function voiceTurnComplete($: EngineInterface, e: EventOf['turn.complete']): Promise<void> {
  if (e.agentId === undefined && e.reason === 'answer' && e.answer.trim() !== '') {
    await update($, lastAnswer, () => e.answer)
    if ((await read($, settings)).isAuto) void play($, e.answer)
  }
}

export function registerVoice(on: On): void {
  on('session.end', async ($, e, next) => {
    await stop($)

    return next(e)
  })
}
