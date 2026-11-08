import { expect, test } from 'claude-code/testing'

import { mascotSvg } from '../hooks/mascot'
import { toSentences, unusualWords, voiceLabel } from '../hooks/speech-text'

const REPLY = [
  '## What changed',
  '',
  'I updated [the config](https://example.com/docs) in `C:\\Users\\me\\project\\settings.json`. It now loads 1.5x faster → nice.',
  '',
  '- **Speed**: up to 3× now',
  '- Fixed the *flaky* test, see https://github.com/org/repo/pull/7',
  '',
  '```ts',
  'const x = 1',
  'const y = 2',
  '```',
  '',
  '| Name | Size |',
  '| --- | --- |',
  '| Ryan | 63 MB |',
  '',
  'Want me to commit? ✅',
].join('\n')

test('a Markdown reply becomes plain spoken sentences', async () => {
  expect(toSentences(REPLY, { isCodeSkipped: true })).toEqual([
    'What changed.',
    'I updated the config in settings.json.',
    'It now loads 1.5x faster to nice.',
    'Speed: up to 3 times now.',
    'Fixed the flaky test, see a link to github dot com.',
    '2 lines of code skipped.',
    'Name, Size.',
    'Ryan, 63 MB.',
    'Want me to commit?',
  ])
  expect(toSentences('```\nlet a = 1\n```', { isCodeSkipped: false })).toEqual(['let a = 1'])
  expect(toSentences('On 10/24/2026 we met.', { isCodeSkipped: true })).toEqual(['On 10/24/2026 we met.'])
})

test('ids, paths, names and marks a voice garbles are made speakable', async () => {
  const reply = [
    'Commits: b1f70e9 and the fix (00a165f). A folder (cde74ad2-...) is empty.',
    'Set `CLAUDE_CODE_PLUGIN_DIRS` in the mcpServers block.',
    String.raw`It is in %LOCALAPPDATA%\Programs\AWSCLIV2 and C:/Users/me/kit/uvx.exe.`,
    'It also writes `.claude/settings.json` · ✓ done.',
  ].join('\n\n')
  expect(toSentences(reply, { isCodeSkipped: true })).toEqual([
    'Commits: b 1 f 7 and the fix.',
    'A folder is empty.',
    'Set claude code plugin dirs in the mcp Servers block.',
    'It is in AWSCLIV2 and uvx.exe.',
    'It also writes .claude/settings.json, done.',
  ])
})

test('domains without http(s):// are read with "dot", file names and numbers are not', async () => {
  const say = (text: string) => toSentences(text, { isCodeSkipped: true })
  expect(say('Send it to app.novakitai.app.')).toEqual(['Send it to app dot novakitai dot app.'])
  expect(say('Terms: https://novakitai.app/terms')).toEqual(['Terms: a link to novakitai dot app.'])
  expect(say('Terms: novakitai.app/terms')).toEqual(['Terms: a link to novakitai dot app.'])
  expect(say('It is live on `www.example.co.uk` now.')).toEqual(['It is live on example dot co dot uk now.'])
  expect(say('Read plan.md first.')).toEqual(['Read plan.md first.'])
  expect(say('It runs at 1.5x.')).toEqual(['It runs at 1.5x.'])
  expect(say('Edit next.config.js and package.json.')).toEqual(['Edit next.config.js and package.json.'])
  expect(say('Upgrade to version 2.1.3.')).toEqual(['Upgrade to version 2.1.3.'])
  expect(say('Mail jane.doe@gmail.com or info@novakitai.app.')).toEqual([
    'Mail jane dot doe at gmail dot com or info at novakitai dot app.',
  ])
})

test('words on the pronunciation list are said its way, whole words in any case', async () => {
  const say = (text: string) =>
    toSentences(text, { isCodeSkipped: true, pronunciations: { novakitai: 'nova kit A I', supabase: 'soupa base' } })
  // The spelled-out letters are said by name: "A" alone would be read "uh".
  expect(say('NovaKitAI is live at app.novakitai.app.')).toEqual(['nova kit eh eye is live at app dot nova kit eh eye dot app.'])
  expect(say('Move the Supabase keys.')).toEqual(['Move the soupa base keys.'])
  expect(
    toSentences('Use me-central-1 and gpt4o.', {
      isCodeSkipped: true,
      pronunciations: { 'me-central-1': 'M E central one', gpt4o: 'G P T four O' },
    }),
  ).toEqual(['Use em ee central one and jee pee tee four oh.'])
  // Ordinary text keeps its letters: only respellings change.
  expect(say('I picked plan A.')).toEqual(['I picked plan A.'])
  // Part of a longer word is left alone.
  expect(say('Mail novakitaiapp@gmail.com.')).toEqual(['Mail novakitaiapp at gmail dot com.'])
  expect(toSentences('NovaKitAI is live.', { isCodeSkipped: true })).toEqual(['Nova Kit AI is live.'])
})

test('unusual words are picked out for Haiku, ordinary ones and known ones are not', async () => {
  const sentences = toSentences(
    [
      'NovaKit now sends its emails from app.novakitai.app.',
      'Move the keys from Supabase to Vercel before the gpt4o upgrade.',
      'The waiting list form is the only part that needs server code.',
    ].join('\n\n'),
    { isCodeSkipped: true },
  )
  const picked = unusualWords(sentences, new Set()).map(found => found.word)
  expect(picked).toEqual(['novakitai', 'Supabase', 'Vercel', 'gpt4o'])
  // Each comes with the sentence it was met in, for Haiku's context.
  expect(unusualWords(sentences, new Set())[0]?.sentence).toBe('Nova Kit now sends its emails from app dot novakitai dot app.')
  // A word already checked or on a list is not asked about again.
  expect(unusualWords(sentences, new Set(['novakitai', 'vercel'])).map(found => found.word)).toEqual(['Supabase', 'gpt4o'])
  // Ordinary prose has nothing to ask about.
  expect(unusualWords(toSentences('The form needs server code. It is ready.', { isCodeSkipped: true }), new Set())).toEqual([])
})

test('voice ids read as names', async () => {
  expect(voiceLabel('en_US-ryan-medium')).toBe('Ryan (US)')
  expect(voiceLabel('en_GB-northern_english_male-medium')).toBe('Northern English Male (UK)')
})

test('the helmet lip-syncs to the loudness the speaker reports', async () => {
  const lip = { envelope: '0369630'.repeat(40), durationMs: 21_000, offsetMs: 1_500 }
  const talking = mascotSvg('talking', lip, 3)
  expect(talking.length).toBeLessThan(131_072)
  expect(talking).toContain('begin="-1.62s"')
  expect(talking).toContain('values="1 0.40;1 0.93;1 1.47;1 2.00')
  expect(mascotSvg('talking')).toContain('chatter')
  for (const mood of ['idle', 'paused'] as const) {
    expect(mascotSvg(mood)).not.toContain('animateTransform')
  }
  // Working: the rings turn and a gold light runs through both eyes, each
  // starting at the clock's phase so a redraw carries on where it was.
  const working = mascotSvg('thinking', undefined, 0, 7_500)
  expect(working).toContain('type="rotate"')
  expect(working).toContain('fill="url(#eyeGold)"')
  expect(working).toContain('values="57 0;125 0"')
  expect(working).toContain('values="221 0;150 0"')
  expect(working).toContain('begin="-1.50s"')
  expect(working).toContain('begin="-0.30s"')
  // A very long sentence is averaged down, so the picture stays inside the frame's size limit.
  const long = { envelope: '05'.repeat(2_000), durationMs: 200_000, offsetMs: 0 }
  expect(mascotSvg('talking', long).length).toBeLessThan(80_000)
})
