// Draws the player's mascot, an Iron Man–style helmet in a black edition
// (soft 3D: gloss-black shell, gunmetal plates, blue eyes), and its progress
// bar, as SVG documents. The desktop shows them in a script-less frame
// (`isInteractive`) where CSS and SMIL animation run by themselves, so the
// helmet moves without the mod redrawing it.

import { HELMET_SHAPES } from './helmet-shapes'

export type Mood = 'idle' | 'thinking' | 'talking' | 'paused'

// How loud the sentence being read is, every 50 ms, as digits 0-9, and where
// in it the voice is: what the mouth, eyes and voice meter follow.
export type Lip = { envelope: string; durationMs: number; offsetMs: number }

// The frame starts its clock a little after the voice does.
const LEAD_MS = 120

const seconds = (ms: number): string => `${(ms / 1000).toFixed(2)}s`

const HUD = '#5CC8FF'
// The mod's gold (the cost cell, a finished plan): the light through the eyes while working.
const EYE_GOLD = '#F2B84B'

// The helmet's centre in the traced drawing's pixels; the picture is a square
// around it with room for the HUD ring and the voice meter.
const CX = 152.5
const CY = 190
const VIEW = `${CX - 165} ${CY - 165} 330 330`
// The mouth line of the drawing: centre and half its length.
const MOUTH = { x: 153, y: 280.5, half: 36 }

const BASE_CSS = `
.float{animation:float 4.2s ease-in-out infinite;transform-origin:${CX}px ${CY}px}
@keyframes float{0%,100%{transform:translateY(0)}50%{transform:translateY(-7px)}}
.thrust{animation:thrust 4.2s ease-in-out infinite;transform-origin:${CX}px 352px}
@keyframes thrust{0%,100%{transform:scale(1);opacity:.75}50%{transform:scale(.8);opacity:.4}}
.tilt{transform-origin:${CX}px 300px}
.eyes{animation:blink 5.6s infinite}
@keyframes blink{0%,91%,100%{opacity:1}93%{opacity:.1}95%{opacity:1}}
.breathe{animation:breathe 3.2s ease-in-out infinite}
@keyframes breathe{0%,100%{opacity:.75}50%{opacity:1}}
`

const MOOD_CSS: Record<Mood, string> = {
  idle: `
.tilt{animation:glance 9s ease-in-out infinite}
@keyframes glance{0%,30%,86%,100%{transform:rotate(0)}38%,52%{transform:rotate(-2.2deg)}60%,76%{transform:rotate(2.2deg)}}
.sweep{animation:sweep 7s ease-in-out infinite}
@keyframes sweep{0%,62%{transform:translateX(-230px)}88%,100%{transform:translateX(230px)}}
`,
  thinking: `
.eyes{animation:none;opacity:.5}
`,
  talking: `
.tilt{animation:nod 4.6s ease-in-out infinite}
@keyframes nod{0%,100%{transform:rotate(-2deg)}25%{transform:rotate(.8deg) translateY(2px)}50%{transform:rotate(2deg)}75%{transform:rotate(-.8deg) translateY(2px)}}
.chatter{animation:chatter .3s ease-in-out infinite alternate;transform-origin:${MOUTH.x}px ${MOUTH.y}px}
@keyframes chatter{from{transform:scaleY(.5);opacity:.4}to{transform:scaleY(1.6);opacity:1}}
.bar{animation:bar .45s ease-in-out infinite alternate}
.b2{animation-delay:.15s}.b3{animation-delay:.3s}
@keyframes bar{from{transform:scaleY(.3)}to{transform:scaleY(1)}}
`,
  paused: `
.float{animation-duration:6.5s}
.eyes{animation:dim 3.2s ease-in-out infinite}
@keyframes dim{0%,100%{opacity:.28}50%{opacity:.45}}
.badge{animation:pulse 2.2s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:.5}50%{opacity:1}}
`,
}

// At most this many loudness steps go into one picture: a long sentence is
// averaged down, so the document stays well inside the frame's size limit.
const MAX_STEPS = 400

const levels = (envelope: string): number[] => {
  const digits = [...envelope].map(digit => Math.max(0, Math.min(9, Number(digit) || 0)) / 9)
  const stride = Math.ceil(digits.length / MAX_STEPS)
  const values =
    stride <= 1
      ? digits
      : Array.from({ length: Math.ceil(digits.length / stride) }, (_, at) => {
          const group = digits.slice(at * stride, at * stride + stride)

          return group.reduce((sum, level) => sum + level, 0) / group.length
        })

  return values.length > 1 ? values : [0, ...values, 0]
}

const timing = (lip: Lip) =>
  `calcMode="linear" fill="freeze" dur="${seconds(lip.durationMs)}" begin="${seconds(-lip.offsetMs - LEAD_MS)}"`

const hasLip = (lip: Lip | undefined): lip is Lip => lip !== undefined && lip.envelope !== '' && lip.durationMs > 0

const path = (d: string, attrs: string) => `<path d="${d}" fill-rule="evenodd" ${attrs}/>`

const DEFS =
  `<clipPath id="helmet"><path d="${HELMET_SHAPES.silhouette}"/></clipPath>` +
  `<clipPath id="plates"><path d="${HELMET_SHAPES.plates.join(' ')}"/></clipPath>` +
  `<clipPath id="eyeShapes"><path d="${HELMET_SHAPES.eyes}"/></clipPath>` +
  `<radialGradient id="shell" cx="30%" cy="18%" r="90%"><stop offset="0" stop-color="#5E646C"/>` +
  `<stop offset=".45" stop-color="#25282D"/><stop offset="1" stop-color="#0B0C0E"/></radialGradient>` +
  `<linearGradient id="plate" x1="0" y1="0" x2=".55" y2="1"><stop offset="0" stop-color="#E6E9ED"/>` +
  `<stop offset=".55" stop-color="#A3A9B1"/><stop offset="1" stop-color="#6A7078"/></linearGradient>` +
  `<linearGradient id="light" x1="0" x2="1"><stop offset="0" stop-color="#fff" stop-opacity=".1"/>` +
  `<stop offset=".5" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".38"/></linearGradient>` +
  `<linearGradient id="sheen" x1="0" x2="1"><stop offset="0" stop-color="#fff" stop-opacity="0"/>` +
  `<stop offset=".5" stop-color="#fff" stop-opacity=".55"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>` +
  `<radialGradient id="thrustGlow"><stop offset="0" stop-color="${HUD}" stop-opacity=".9"/>` +
  `<stop offset="1" stop-color="${HUD}" stop-opacity="0"/></radialGradient>` +
  `<filter id="lift" x="-5%" y="-5%" width="110%" height="110%"><feDropShadow dx="0" dy="1.2" stdDeviation="1.2" flood-opacity=".55"/></filter>` +
  `<filter id="glow" x="-50%" y="-150%" width="200%" height="400%"><feGaussianBlur stdDeviation="2.4" result="b"/>` +
  `<feMerge><feMergeNode in="b"/><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>` +
  `<filter id="bigGlow" x="-50%" y="-300%" width="200%" height="700%"><feGaussianBlur stdDeviation="4"/></filter>` +
  `<filter id="blur"><feGaussianBlur stdDeviation="2"/></filter>` +
  `<linearGradient id="eyeGold" x1="0" x2="1"><stop offset="0" stop-color="${EYE_GOLD}" stop-opacity="0"/>` +
  `<stop offset=".5" stop-color="#FFE3A3"/><stop offset="1" stop-color="${EYE_GOLD}" stop-opacity="0"/></linearGradient>`

// The helmet itself, the same in every mood: shell, lifted plates each shaded
// on its own, the drawing's ink lines, side light and a gloss on the dome.
const HELMET =
  path(HELMET_SHAPES.silhouette, 'fill="#08090A"') +
  path(HELMET_SHAPES.shell, 'fill="url(#shell)"') +
  `<g filter="url(#lift)">${HELMET_SHAPES.plates.map(d => path(d, 'fill="url(#plate)"')).join('')}</g>` +
  path(HELMET_SHAPES.ink, 'fill="#101114" opacity=".85"') +
  `<g clip-path="url(#helmet)"><rect x="60" y="42" width="186" height="296" fill="url(#light)"/>` +
  `<path d="M82 92C96 62 124 48 150 46C126 56 104 72 94 96Z" fill="#fff" opacity=".28" filter="url(#blur)"/></g>`

// The eyes breathe, blink, and burn brighter on louder words.
function eyes(mood: Mood, lip: Lip | undefined): string {
  const voice =
    mood === 'talking' && hasLip(lip)
      ? `<animate attributeName="opacity" ${timing(lip)} values="${levels(lip.envelope)
          .map(level => (0.7 + 0.3 * level).toFixed(2))
          .join(';')}"/>`
      : ''

  return (
    `<g class="eyes"><g class="breathe">${voice}` +
    path(HELMET_SHAPES.eyes, 'fill="#2FB2FF" filter="url(#glow)"') +
    path(HELMET_SHAPES.eyes, 'fill="#E4F7FF"') +
    `</g></g>`
  )
}

// A glow through the mouth line that opens and brightens with the voice.
function mouth(mood: Mood, lip: Lip | undefined): string {
  if (mood !== 'talking') return ''
  const glow =
    `<ellipse rx="${MOUTH.half}" ry="3.2" fill="#9FE3FF" filter="url(#bigGlow)"/>` +
    `<ellipse rx="${MOUTH.half - 4}" ry="1.6" fill="#E4F7FF"/>`
  if (!hasLip(lip)) return `<g class="chatter"><g transform="translate(${MOUTH.x} ${MOUTH.y})">${glow}</g></g>`
  const values = levels(lip.envelope)

  return (
    `<g transform="translate(${MOUTH.x} ${MOUTH.y})"><g opacity=".2">` +
    `<animate attributeName="opacity" ${timing(lip)} values="${values.map(level => (0.15 + 0.85 * level).toFixed(2)).join(';')}"/>` +
    `<g transform="scale(1 .4)"><animateTransform attributeName="transform" type="scale" ${timing(lip)} ` +
    `values="${values.map(level => `1 ${(0.4 + 1.6 * level).toFixed(2)}`).join(';')}"/>` +
    `${glow}</g></g></g>`
  )
}

// The helmet bobs a little with the loudness of the speech.
function bounce(mood: Mood, lip: Lip | undefined): string {
  if (mood !== 'talking' || !hasLip(lip)) return ''
  const values = levels(lip.envelope)
    .map(level => `0 ${(-5 * level).toFixed(2)}`)
    .join(';')

  return `<animateTransform attributeName="transform" type="translate" ${timing(lip)} values="${values}"/>`
}

// A JARVIS-style voice meter on each side: three bars that rise with the voice.
function voiceMeter(lip: Lip | undefined): string {
  const bar = (x: number, at: number, height: number) => {
    const shape = `<rect x="-4" y="${-height / 2}" width="8" height="${height}" rx="4" fill="${HUD}"/>`
    if (!hasLip(lip)) {
      return `<g transform="translate(${x} ${CY})"><g class="bar b${at + 1}">${shape}</g></g>`
    }
    // Each bar follows the voice a step behind the one before, so the meter ripples.
    const steps = levels(lip.envelope)
    const values = steps
      .map((_, step) => steps[Math.max(0, step - at)] ?? 0)
      .map(level => `1 ${(0.15 + 0.85 * level).toFixed(2)}`)
      .join(';')

    return (
      `<g transform="translate(${x} ${CY})"><g transform="scale(1 .15)">` +
      `<animateTransform attributeName="transform" type="scale" ${timing(lip)} values="${values}"/>${shape}</g></g>`
    )
  }
  const side = (xs: readonly number[]) => xs.map((x, at) => bar(x, at, [44, 70, 44][at] ?? 44)).join('')

  return `<g opacity=".85" filter="url(#glow)">${side([CX - 112, CX - 128, CX - 144])}${side([CX + 112, CX + 128, CX + 144])}</g>`
}

// The working animations are SMIL, not CSS: SMIL runs in an image whatever
// the page's motion settings, and each starts at the clock's phase, so a
// redrawn picture carries on where the last one was instead of starting over.
const RING_MS = 6000
const RING2_MS = 9000
const EYE_SWEEP_MS = 1200
const phase = (at: number, periodMs: number): string => seconds(-(((at % periodMs) + periodMs) % periodMs))
const spin = (at: number, periodMs: number, isReversed: boolean) =>
  `<animateTransform attributeName="transform" type="rotate" from="0 ${CX} ${CY}" to="${isReversed ? -360 : 360} ${CX} ${CY}" ` +
  `dur="${seconds(periodMs)}" begin="${phase(at, periodMs)}" repeatCount="indefinite"/>`

// While working, a gold light runs through each eye, toward the nose in both:
// left to right in the left eye, right to left in the right one.
function eyeSweep(at: number): string {
  const band = 28
  const timing = `dur="${seconds(EYE_SWEEP_MS)}" begin="${phase(at, EYE_SWEEP_MS)}" repeatCount="indefinite"`
  const runner = (from: number, to: number) =>
    `<rect x="0" y="176" width="${band}" height="26" fill="url(#eyeGold)">` +
    `<animateTransform attributeName="transform" type="translate" values="${from} 0;${to} 0" ${timing}/></rect>`

  return (
    `<g clip-path="url(#eyeShapes)" filter="url(#glow)">` +
    // Eyes span x 85-125 and 178-221 in the drawing; each light enters and leaves its eye fully.
    runner(85 - band, 125) +
    runner(221, 178 - band) +
    `</g>`
  )
}

function extras(mood: Mood, lip: Lip | undefined, at: number): string {
  if (mood === 'thinking') {
    return (
      `<g fill="none" stroke="${HUD}" stroke-linecap="round" opacity=".8">` +
      `<circle cx="${CX}" cy="${CY}" r="158" stroke-width="3.5" stroke-dasharray="60 26 12 26">${spin(at, RING_MS, false)}</circle>` +
      `<circle cx="${CX}" cy="${CY}" r="146" stroke-width="2.2" stroke-dasharray="8 16" opacity=".7">${spin(at, RING2_MS, true)}</circle></g>`
    )
  }
  if (mood === 'talking') return voiceMeter(lip)
  if (mood === 'paused') {
    return (
      `<g class="badge" fill="${HUD}"><rect x="262" y="34" width="48" height="48" rx="16" fill-opacity=".18" ` +
      `stroke="${HUD}" stroke-opacity=".6" stroke-width="2"/>` +
      `<rect x="276" y="46" width="7" height="24" rx="3.5"/><rect x="289" y="46" width="7" height="24" rx="3.5"/></g>`
    )
  }

  return ''
}

// `take` changes the document so the frame restarts the animation even when
// nothing else did (the same sentence started again). `at` is the clock, in
// milliseconds, that the working animations keep their place by.
export function mascotSvg(mood: Mood, lip?: Lip, take = 0, at = 0): string {
  const sweep =
    mood === 'idle'
      ? `<g clip-path="url(#plates)"><rect class="sweep" x="${CX - 40}" y="40" width="80" height="300" ` +
        `fill="url(#sheen)" transform="skewX(-18)"/></g>`
      : ''
  const scan = mood === 'thinking' ? eyeSweep(at) : ''

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${VIEW}" width="100%" height="100%"><!--${mood} ${take}-->` +
    `<style>${BASE_CSS}${MOOD_CSS[mood]}@media (prefers-reduced-motion:reduce){*{animation:none!important}}</style>` +
    `<defs>${DEFS}</defs>` +
    `<ellipse class="thrust" cx="${CX}" cy="352" rx="52" ry="9" fill="url(#thrustGlow)"/>` +
    extras(mood, lip, at) +
    `<g class="float"><g class="tilt"><g>${bounce(mood, lip)}` +
    HELMET +
    sweep +
    eyes(mood, lip) +
    scan +
    mouth(mood, lip) +
    `</g></g></g></svg>`
  )
}

// A thin capsule that fills as the reading goes, gliding through the current
// sentence while the voice speaks it.
export function progressSvg(index: number, total: number, lip: Lip | undefined, isMoving: boolean, take = 0): string {
  const width = 240
  const span = total > 0 ? width / total : 0
  const done = Math.min(width, index * span)
  const into = lip !== undefined && lip.durationMs > 0 ? Math.min(1, lip.offsetMs / lip.durationMs) : 0
  const now = done + span * into
  const glide =
    isMoving && lip !== undefined && lip.durationMs > lip.offsetMs
      ? `<animate attributeName="width" from="${Math.max(6, now).toFixed(1)}" to="${Math.max(6, done + span).toFixed(1)}" ` +
        `dur="${seconds(lip.durationMs - lip.offsetMs)}" begin="${seconds(-LEAD_MS)}" fill="freeze"/>`
      : ''

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} 6" width="100%" height="100%" preserveAspectRatio="none">` +
    `<!--${take}--><defs><linearGradient id="fill" x1="0" x2="1"><stop offset="0" stop-color="#6B7179"/>` +
    `<stop offset="1" stop-color="${HUD}"/></linearGradient></defs>` +
    `<rect width="${width}" height="6" rx="3" fill="#8A8A8A" fill-opacity=".3"/>` +
    `<rect width="${Math.max(6, now).toFixed(1)}" height="6" rx="3" fill="url(#fill)">${glide}</rect></svg>`
  )
}
