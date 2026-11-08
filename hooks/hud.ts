// The HUD's rows as SVG documents: mission (plan steps as armour plates),
// telemetry (one cell per number) and voice (the sentence being read). The
// desktop wraps sibling elements onto new lines, so each row is one drawing
// and only its buttons sit beside it.

import type { Flow, Stats, VoicePlayer } from '../types'
import { formatSpeed } from './speech-text'
import type { CacheLevel } from './telemetry'

export const HUD = {
  cyan: '#5CC8FF',
  ice: '#E4F7FF',
  gold: '#F2B84B',
  orange: '#FF9F43',
  red: '#FF4757',
  muted: '#7F8B97',
  dim: '#3A4652',
  panel: '#0A1017',
  edge: '#1E4A66',
} as const

const LABEL = "Bahnschrift,'DIN Alternate','Segoe UI',sans-serif"
const MONO = "'Cascadia Mono',Consolas,'SF Mono',monospace"

export const xml = (s: string): string =>
  s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)

// Rough advance of the label font, in em; Bahnschrift runs narrower, so this
// errs toward cutting a little early rather than overflowing.
const charEm = (ch: string): number => (/[\s.,:;'|!il1()[\]]/.test(ch) ? 0.28 : /[A-Z@%mw]/.test(ch) ? 0.66 : 0.52)

export const textWidth = (s: string, size: number): number => [...s].reduce((w, ch) => w + charEm(ch) * size, 0)

// Cuts `s` to fit `maxW` pixels, with an ellipsis when it had to cut.
export const fitText = (s: string, size: number, maxW: number): string => {
  if (textWidth(s, size) <= maxW) return s
  let out = ''
  for (const ch of s) {
    if (textWidth(out + ch + '…', size) > maxW) break
    out += ch
  }

  return out.trimEnd() + '…'
}

const doc = (W: number, H: number, body: string, css = ''): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
  `<style>text{font-family:${LABEL}}.mono{font-family:${MONO}}${css}` +
  `@media (prefers-reduced-motion:reduce){*{animation:none!important}}</style>${body}</svg>`

const label = (x: number, y: number, text: string, fill: string = HUD.muted, anchor = 'start') =>
  `<text x="${x}" y="${y}" font-size="9.5" letter-spacing="1.8" fill="${fill}" text-anchor="${anchor}">${xml(text.toUpperCase())}</text>`

// --- mission ---------------------------------------------------------------

export const MISSION_H = 24
const MAX_PLATES = 12

const ratioOf = (f: Flow): number => (f.isFinished ? 1 : f.total ? f.done / f.total : 0)

// A parallelogram, the plate's shape.
const plate = (x: number, w: number, h: number, slant = 6) =>
  `M${x + slant} 0H${x + w}L${x + w - slant} ${h}H${x}Z`

export function missionSvg(f: Flow, W: number): string {
  const H = MISSION_H
  const kind = f.source === 'agents' ? 'Agents' : 'Mission'
  const title = fitText(f.title, 15, Math.min(300, W * 0.32))
  const titleX = 66
  const barX = Math.round(titleX + textWidth(title, 15) + 16)
  const percent = `${Math.round(ratioOf(f) * 100)}%`
  const barW = Math.max(60, W - barX - 58)
  const fill = f.isFinished ? HUD.gold : HUD.cyan
  const plateH = 16
  const y0 = (H - plateH) / 2
  let bar = ''

  if (f.total > 0 && f.total <= MAX_PLATES) {
    const gap = 5
    const w = (barW - gap * (f.total - 1)) / f.total
    for (let i = 0; i < f.total; i++) {
      const x = i * (w + gap)
      const state = f.isFinished || i < f.done ? 'done' : i < f.done + f.running || (i === f.done && !f.isFinished) ? 'run' : 'wait'
      const shape = plate(x, w, plateH)
      const fillOf = state === 'done' ? `url(#m2m-done)` : state === 'run' ? 'url(#m2m-hatch)' : '#16212C'
      const stroke = state === 'run' ? HUD.cyan : state === 'done' ? 'none' : '#26333F'
      bar +=
        `<path class="${state}" d="${shape}" fill="${fillOf}" stroke="${stroke}" stroke-width="1"/>` +
        (w > 22
          ? `<text class="mono" x="${x + w / 2}" y="${plateH / 2 + 3.2}" font-size="9" text-anchor="middle" fill="${state === 'done' ? '#03121C' : state === 'run' ? HUD.ice : HUD.muted}">${String(i + 1).padStart(2, '0')}</text>`
          : '')
    }
  } else {
    // No count yet, or too many steps for plates: one rail that fills.
    const fillW = Math.round(barW * ratioOf(f))
    const ticks =
      f.total > 1
        ? Array.from({ length: f.total - 1 }, (_, k) => {
            const x = Math.round((barW * (k + 1)) / f.total)
            return x > fillW + 3 ? `<rect x="${x}" y="${plateH / 2 - 3}" width="1" height="6" fill="#33414E"/>` : ''
          }).join('')
        : ''
    const phase = f.total === 0 && !f.isFinished ? (f.phase === 'design' ? 'Designing' : 'Planning') : ''
    bar =
      `<path d="${plate(0, barW, plateH)}" fill="#16212C" stroke="#26333F"/>` +
      (fillW > 0 ? `<path class="done" d="${plate(0, Math.max(14, fillW), plateH)}" fill="url(#m2m-done)"/>` : '') +
      ticks +
      (phase ? `<text x="${barW / 2}" y="${plateH / 2 + 3.5}" font-size="10" letter-spacing="2" text-anchor="middle" fill="${HUD.cyan}" class="pulse">${phase.toUpperCase()}</text>` : '')
  }

  const css =
    '.run{animation:runp 1.2s ease-in-out infinite}@keyframes runp{50%{opacity:.55}}' +
    '.done{filter:url(#m2m-glow)}.pulse{animation:runp 1.6s ease-in-out infinite}'

  return doc(
    W,
    H,
    `<defs><linearGradient id="m2m-done" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${f.isFinished ? '#FFE3A3' : '#9FE3FF'}"/><stop offset="1" stop-color="${fill}"/></linearGradient>` +
      `<pattern id="m2m-hatch" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="8" height="8" fill="#123047"/><rect width="3" height="8" fill="#2E7DA8"/></pattern>` +
      `<filter id="m2m-glow" x="-20%" y="-60%" width="140%" height="220%"><feGaussianBlur stdDeviation="2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>` +
      label(0, H / 2 + 3.5, kind) +
      `<text x="${titleX}" y="${H / 2 + 5}" font-size="15" font-weight="600" fill="${HUD.ice}">${xml(title)}</text>` +
      `<g transform="translate(${barX} ${y0})">${bar}</g>` +
      `<text class="mono" x="${W}" y="${H / 2 + 5}" font-size="14" font-weight="600" text-anchor="end" fill="${fill}">${percent}</text>`,
    css,
  )
}

// --- telemetry -------------------------------------------------------------

export const STATS_H = 40

type Cell = { key: string; label: string; value: string; suffix?: string; color: string; width: number; drain?: number }

const pad = (n: number) => String(n).padStart(2, '0')
const usd = (n: number) => `$${n.toFixed(2)}`

export function statsCells(s: Stats, secondsLeft: number | null, level: CacheLevel, isWorking: boolean): Cell[] {
  const cacheColor = level === 'alert' ? HUD.red : level === 'warn' ? HUD.orange : HUD.cyan
  const cacheText = isWorking
    ? '…'
    : secondsLeft === null
      ? '—'
      : secondsLeft === 0
        ? 'expired'
        : `${pad(Math.floor(secondsLeft / 60))}:${pad(secondsLeft % 60)}`
  const contextColor = s.context >= 85 ? HUD.red : s.context >= 65 ? HUD.orange : HUD.gold

  return [
    { key: 'turn', label: 'Turn', value: pad(s.turn), color: HUD.cyan, width: 58 },
    { key: 'speed', label: 'Speed', value: s.speed === null ? '—' : String(s.speed), suffix: s.speed === null ? '' : 'tok/s', color: HUD.cyan, width: 96 },
    { key: 'cost', label: 'Cost', value: s.turnCost === null ? '—' : usd(s.turnCost), suffix: `/ ${usd(s.total)}`, color: HUD.gold, width: 138 },
    {
      key: 'cache',
      label: level === 'alert' ? 'Cache expires' : 'Cache',
      value: cacheText,
      color: cacheColor,
      width: 96,
      drain: secondsLeft === null || isWorking ? undefined : secondsLeft / 3600,
    },
    { key: 'context', label: 'Context', value: `${s.context}%`, color: contextColor, width: 96, drain: s.context / 100 },
    ...(s.limit === null
      ? []
      : [
          {
            key: 'limit',
            label: 'Session limit',
            value: `${Math.round(s.limit)}%`,
            suffix: s.limitResetsAt === null ? '' : `resets ${resetTime(s.limitResetsAt)}`,
            color: s.limit >= 90 ? HUD.red : s.limit >= 70 ? HUD.orange : HUD.cyan,
            width: 168,
            drain: s.limit / 100,
          },
        ]),
  ]
}

// The reset as a local clock time, "3:15 pm": it never goes stale between redraws.
export const resetTime = (at: number): string => {
  const d = new Date(at)
  const h = d.getHours()
  return `${h % 12 || 12}:${pad(d.getMinutes())} ${h < 12 ? 'am' : 'pm'}`
}

// Narrow bands drop the speed, then the turn, then the limit, so the row never
// wraps. The drawing is only as wide as its cells: the ⋯ and × sit at the
// band's right edge on their own.
export function statsSvg(cells: Cell[], W: number): string {
  const gap = 10
  let shown = cells
  for (const drop of ['speed', 'turn', 'limit']) {
    if (shown.reduce((w, c) => w + c.width + gap, 0) <= W) break
    shown = shown.filter(c => c.key !== drop)
  }
  let x = 0
  const body = shown
    .map((c, i) => {
      const g =
        `<g transform="translate(${x} 0)">` +
        `<rect width="${c.width}" height="${STATS_H}" fill="url(#m2s-cell${i})"/>` +
        `<rect width="2" height="${STATS_H}" fill="${c.color}"/>` +
        label(10, 13, c.label) +
        `<text class="mono" x="10" y="31" font-size="16" font-weight="600" fill="${c.key === 'turn' || c.key === 'speed' ? HUD.ice : c.color}">${xml(c.value)}` +
        (c.suffix ? `<tspan font-size="10.5" font-weight="400" fill="${HUD.muted}" dx="5">${xml(c.suffix)}</tspan>` : '') +
        `</text>` +
        (c.drain === undefined
          ? ''
          : `<rect x="10" y="35.5" width="${c.width - 24}" height="2.5" fill="#26333F"/>` +
            `<rect x="10" y="35.5" width="${Math.max(2, (c.width - 24) * Math.min(1, Math.max(0, c.drain)))}" height="2.5" fill="${c.color}" filter="url(#m2s-glow)"/>`) +
        `</g>`
      x += c.width + gap
      return g
    })
    .join('')
  const grads = shown
    .map(
      (c, i) =>
        `<linearGradient id="m2s-cell${i}" x1="0" x2="1"><stop offset="0" stop-color="${c.color}" stop-opacity=".14"/><stop offset="1" stop-color="${c.color}" stop-opacity="0"/></linearGradient>`,
    )
    .join('')

  return doc(
    Math.max(1, Math.min(W, x - gap)),
    STATS_H,
    `<defs>${grads}<filter id="m2s-glow" x="-10%" y="-200%" width="120%" height="500%"><feGaussianBlur stdDeviation="1.5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>${body}`,
  )
}

// --- voice -----------------------------------------------------------------

export const VOICE_H = 26

type VoiceView = { player: VoicePlayer; speed: number; isAuto: boolean; mode: 'full' | 'summary'; hasVoices: boolean }

export function voiceSvg(v: VoiceView, W: number): string {
  const H = VOICE_H
  const p = v.player
  const isReading = p.status === 'starting' || p.status === 'playing' || p.status === 'paused'
  const state = {
    idle: 'Standby',
    summarizing: 'Summarizing',
    starting: 'Getting ready',
    playing: p.source === 'summary' ? 'Speaking summary' : 'Speaking',
    paused: 'Paused',
  }[p.status]
  const tone = p.status === 'idle' ? HUD.muted : p.status === 'paused' ? HUD.gold : HUD.cyan
  const y = H / 2 + 4
  let x = 0
  let body = `<circle class="${p.status === 'playing' || p.status === 'starting' || p.status === 'summarizing' ? 'beat' : ''}" cx="4" cy="${H / 2}" r="3.5" fill="${tone}" filter="url(#m2v-glow)"/>`
  x = 14
  body += label(x, y - 0.5, state, tone)
  x += textWidth(state.toUpperCase(), 9.5) + state.length * 1.8 + 10
  if (isReading && p.total > 0) {
    const count = `${Math.min(p.index + 1, p.total)}`
    body += `<text class="mono" x="${x}" y="${y}" font-size="13" font-weight="600" fill="${HUD.ice}">${count}<tspan fill="${HUD.muted}">/${p.total}</tspan></text>`
    x += (count.length + String(p.total).length + 1) * 7.9 + 10
  }
  if (v.speed !== 1) {
    const tag = formatSpeed(v.speed)
    const w = tag.length * 7 + 10
    body +=
      `<rect x="${x}" y="${H / 2 - 8}" width="${w}" height="16" fill="none" stroke="${HUD.gold}" stroke-opacity=".55"/>` +
      `<text class="mono" x="${x + w / 2}" y="${H / 2 + 4}" font-size="11" text-anchor="middle" fill="${HUD.gold}">${xml(tag)}</text>`
    x += w + 12
  }
  body += `<rect x="${x}" y="4" width="1" height="${H - 8}" fill="${HUD.edge}"/>`
  x += 12

  const words = isReading
    ? p.sentence
    : p.status === 'summarizing'
      ? 'Condensing the reply into a few spoken sentences.'
      : !v.hasVoices
        ? 'No voice installed yet: run /mk2-hud voices.'
        : v.isAuto
          ? 'New replies play by themselves.'
          : `Press play to hear Claude's last reply${v.mode === 'summary' ? ' as a summary' : ''}.`
  body += `<text x="${x}" y="${y}" font-size="13" font-weight="400" fill="${isReading ? HUD.ice : HUD.muted}">${xml(fitText(words, 13, W - x - 4))}</text>`

  return doc(
    W,
    H,
    `<defs><filter id="m2v-glow" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="1.6" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>${body}`,
    '.beat{animation:beat 1.4s ease-in-out infinite}@keyframes beat{50%{opacity:.3}}',
  )
}
