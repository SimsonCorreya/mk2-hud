import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { gaugeSvg, resetWhen } from '../hooks/limits'
import { STATS, WARM } from '../hooks/state'
import { LIMITS_PANE } from '../hooks/warm'

const PANE = {
  plugin: 'mark-2-hud',
  component: 'Pane',
  requestId: LIMITS_PANE,
  props: {
    title: 'Cache & limit',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const startSession = async ($: Parameters<TestBody>[0], on: Parameters<TestBody>[1], surface: 'desktop' | 'terminal') => {
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

for (const surface of ['desktop', 'terminal'] as const) {
  test(`the Cache & limit panel switches keep warm and the shield: ${surface}`, async ($, on) => {
    await startSession($, on, surface)
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ key: 'cache' })).toBeDefined()
    const drawn = async () => JSON.stringify(await ui.drawn())
    expect(await drawn()).toContain('No reading yet')
    expect(await drawn()).toContain('THESE USE YOUR LIMITS')
    expect(await drawn()).toContain('WHY THEY CAN STILL SAVE')
    expect(await drawn()).toContain('Learn new words')
    expect(await drawn()).toContain('RUNS ON YOUR COMPUTER ONLY')

    await ui.press({ key: 'warm-on' })
    expect(await ui.find({ key: 'warm-off' })).toBeDefined()
    await ui.press({ key: 'warm-off' })
    expect(await ui.find({ key: 'warm-on' })).toBeDefined()

    await ui.press({ key: 'shield-on' })
    expect(await ui.find({ key: 'shield-off' })).toBeDefined()
    await ui.press({ key: 'shield-at-up' })
    expect(await drawn()).toContain('90%')
    await ui.press({ key: 'shield-off' })
    expect(await ui.find({ key: 'shield-on' })).toBeDefined()
    await ui.unmount()
  })
}

test('a meter draws its value and bar; resets name the weekday once a day away', async () => {
  const svg = gaugeSvg('Weekly', '18%', 'resets Mon 9:00 am', 0.18, '#5CC8FF')
  expect(svg).toContain('18%')
  expect(svg).toContain('width="58"')
  const now = new Date(2026, 10, 7, 12, 0).getTime()
  expect(resetWhen(new Date(2026, 10, 7, 15, 5).getTime(), now)).toBe('3:05 pm')
  expect(resetWhen(new Date(2026, 10, 9, 9, 0).getTime(), now)).toBe('Mon 9:00 am')
})

test('values saved by an earlier version, without the newer fields, still draw', async ($, on) => {
  // No session start, so nothing fills the missing fields first: the panel
  // reads the values exactly as the earlier version left them.
  mock.clock(on, { now: 1_000 })
  // As the version before the shield stored them: no ping measurement, no weekly limit.
  const { pingPercent: _p, limitAtPing: _l, ...oldWarm } = { ...WARM, status: 'on' as const, sent: 1, lastCost: 0.04, totalCost: 0.04 }
  const { weekLimit: _w, weekResetsAt: _r, ...oldStats } = { ...STATS, turn: 3, limit: 42 }
  // What the code before this edit wrote stays through the reload.
  on('state.get', ($, e, next) => {
    const key = (e as { key?: string }).key
    if (key === 'warm') return { value: { value: oldWarm, version: 1 } }
    if (key === 'stats') return { value: { value: oldStats, version: 1 } }
    return next(e)
  })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const drawn = JSON.stringify(await ui.drawn())
  expect(drawn).toContain('Last ping: $0.04')
  expect(drawn).toContain('42%')
  expect(drawn).not.toContain('NaN')
  await ui.unmount()
})
