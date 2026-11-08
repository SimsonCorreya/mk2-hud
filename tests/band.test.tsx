import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { missionSvg, statsCells, statsSvg, voiceSvg } from '../hooks/hud'
import { IDLE } from '../hooks/state'

const BAND = {
  plugin: 'mark-2-hud',
  component: 'AbovePrompt',
  requestId: 'above-prompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 140,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

type Surface = 'terminal' | 'desktop' | 'vscode' | 'mobile'

// Nothing sits beneath the plugin: these hooks stand for the engine.
const startSession = async ($: Parameters<TestBody>[0], on: Parameters<TestBody>[1], surface: Surface) => {
  mock.clock(on, { now: 1_000 })
  mock.store(on)
  mock.env(on, {})
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)

    return <Box />
  })
  on('command.register', () => ({ value: { command: 'mark-2-hud' } }))
  on('tool.register', () => ({ value: { tool: 'progress' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface, isInteractive: true })
}

for (const surface of ['desktop', 'vscode', 'mobile', 'terminal'] as const) {
  test(`every surface draws the HUD whole: ${surface}`, async ($, on) => {
    await startSession($, on, surface)
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(JSON.stringify(await ui.drawn()).length).toBeGreaterThan(100)
    expect(await ui.find({ key: 'play' })).toBeDefined()
    await ui.press({ key: 'hide' })
    expect(await ui.find({ key: 'expand' })).toBeDefined()
    await ui.press({ key: 'expand' })
    expect(await ui.find({ key: 'play' })).toBeDefined()
    await ui.unmount()
  })
}

test('the desktop HUD: play reads the reply, ⋯ opens the tray with speed in it', async ($, on) => {
  await startSession($, on, 'desktop')
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ key: 'play' }))?.props.label).toBe('▶')
  // Speed lives in the tray, not the row.
  expect(await ui.find({ key: 'speed' })).toBeUndefined()

  // Before the first turn there is no stats row, so ⋯ sits on the voice row.
  await ui.press({ key: 'options' })
  expect(await ui.find({ key: 'tray' })).toBeDefined()
  await ui.select({ key: 'speed', value: '1.25' })
  expect((await ui.find({ key: 'speed' }))?.props.value).toBe('1.25')
  await ui.select({ key: 'mode', value: 'summary' })
  expect((await ui.find({ key: 'mode' }))?.props.value).toBe('summary')
  await ui.press({ key: 'options' })
  expect(await ui.find({ key: 'tray' })).toBeUndefined()
  await ui.unmount()
})

test('under the end-of-turn box the HUD folds to the helmet and play', async ($, on) => {
  await startSession($, on, 'desktop')
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop', props: { ...BAND.props, hasSurvey: true } })
  expect(await ui.find({ key: 'play' })).toBeDefined()
  expect(await ui.find({ key: 'options' })).toBeUndefined()
  expect(await ui.find({ key: 'expand' })).toBeUndefined()
  await ui.unmount()
})

test('a reported plan draws one plate per step, the next one running', async () => {
  const flow = {
    title: 'Start marketing phase 2',
    total: 5,
    done: 3,
    running: 0,
    phase: 'delegate' as const,
    isFinished: false,
    tasks: [],
    source: 'plan' as const,
  }
  const svg = missionSvg(flow, 700)
  expect(svg.match(/class="done"/g)?.length).toBe(3)
  expect(svg.match(/class="run"/g)?.length).toBe(1)
  expect(svg.match(/class="wait"/g)?.length).toBe(1)
  expect(svg).toContain('60%')
  // Past twelve steps the plates give way to one rail.
  expect(missionSvg({ ...flow, total: 30, done: 6 }, 700)).not.toContain('class="wait"')
  expect(missionSvg({ ...flow, title: 'A & <b>' }, 700)).toContain('A &amp; &lt;b&gt;')
})

test('the stats row turns the cache red under ten minutes and drops cells when narrow', async () => {
  const stats = { turn: 2, speed: 76, turnCost: 0.36, total: 2.37, context: 26, costAtStart: 0, limit: null, limitResetsAt: null, weekLimit: null, weekResetsAt: null }
  const red = statsCells(stats, 4 * 60, 'alert', false).find(c => c.key === 'cache')
  expect(red?.color).toBe('#FF4757')
  expect(red?.value).toBe('04:00')
  const wide = statsSvg(statsCells(stats, 3000, 'ok', false), 700)
  expect(wide).toContain('TURN')
  const narrow = statsSvg(statsCells(stats, 3000, 'ok', false), 380)
  expect(narrow).not.toContain('SPEED')
  expect(narrow).toContain('CONTEXT')
})

test('the voice row shows the sentence, its place and a speed tag', async () => {
  const reading = { ...IDLE, status: 'playing' as const, index: 3, total: 21, sentence: 'The landing page now loads the pricing table.' }
  const svg = voiceSvg({ player: reading, speed: 1.25, isAuto: false, mode: 'full', hasVoices: true }, 700)
  expect(svg).toContain('SPEAKING')
  expect(svg).toContain('4<tspan')
  expect(svg).toContain('1.25×')
  expect(svg).toContain('The landing page now loads the pricing table.')
  const idle = voiceSvg({ player: IDLE, speed: 1, isAuto: true, mode: 'full', hasVoices: true }, 700)
  expect(idle).toContain('New replies play by themselves.')
  expect(idle).not.toContain('×')
})

test('the session limit shows with its reset time, and drops before cost on a narrow band', async () => {
  const s = { turn: 5, speed: 76, turnCost: 1.55, total: 12.35, context: 65, costAtStart: 0, limit: 42, limitResetsAt: new Date(2026, 10, 7, 15, 5).getTime(), weekLimit: null, weekResetsAt: null }
  const cells = statsCells(s, 600, 'ok', false)
  const limit = cells.find(c => c.key === 'limit')
  expect(limit?.value).toBe('42%')
  expect(limit?.suffix).toBe('resets 3:05 pm')
  expect(statsSvg(cells, 2000)).toContain('SESSION LIMIT')
  // Drawn only as wide as its cells, so the buttons beside it stay in the band.
  expect(statsSvg(cells, 2000)).not.toContain('width="2000"')
  expect(statsSvg(cells, 400)).not.toContain('SESSION LIMIT')
  expect(statsCells({ ...s, limit: null }, 600, 'ok', false).some(c => c.key === 'limit')).toBe(false)
})
