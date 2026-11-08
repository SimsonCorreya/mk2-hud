// Turns a Markdown reply into plain sentences a speech engine reads well.

export type SpeechOptions = {
  isCodeSkipped: boolean
  /** How to say words the voice gets wrong, keyed by the word in lower case. */
  pronunciations?: Record<string, string>
}

// Each letter's name as the voice says it right. Alone, a capital letter is
// read as a word ("A" as "uh"), so a respelling's spelled-out letters ("nova kit
// A I") are said with these instead. Each was checked against the voice's own
// pronunciation (en_US Piper, espeak-ng): "ef", not "eff", which it spells out.
const LETTER_NAMES: Record<string, string> = {
  A: 'eh', B: 'bee', C: 'see', D: 'dee', E: 'ee', F: 'ef', G: 'jee', H: 'aitch', I: 'eye',
  J: 'jay', K: 'kay', L: 'ell', M: 'em', N: 'en', O: 'oh', P: 'pee', Q: 'cue', R: 'are',
  S: 'ess', T: 'tee', U: 'you', V: 'vee', W: 'double you', X: 'ex', Y: 'why', Z: 'zee',
}

export const speakLetters = (respelling: string): string =>
  respelling.replace(/(?<![\p{L}\p{N}])[A-Z](?![\p{L}\p{N}])/gu, letter => LETTER_NAMES[letter] ?? letter)

// One pattern for every word on the list: whole words, any case.
function pronunciationPattern(pronunciations: Record<string, string> | undefined): RegExp | undefined {
  const words = Object.keys(pronunciations ?? {})
    .sort((a, b) => b.length - a.length)
    // A hyphen needs no escape outside a class, and in a `u` pattern must not have one.
    .map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  if (words.length === 0) return undefined

  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${words.join('|')})(?![\\p{L}\\p{N}])`, 'giu')
}

export const SPEEDS = [0.5, 0.75, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3] as const

export const formatSpeed = (speed: number): string => `${speed}×`

// "en_US-ryan-medium" is "Ryan (US)"; "en_GB-northern_english_male-medium"
// is "Northern English Male (UK)".
export function voiceLabel(id: string): string {
  const [locale = '', name = id] = id.split('-')
  const region = locale.split('_')[1]
  const words = name
    .split('_')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')

  return region === undefined ? words : `${words} (${region === 'GB' ? 'UK' : region})`
}

const SYMBOLS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\s*(→|->|⇒|=>)\s*/g, ' to '],
  [/\s*(←|<-)\s*/g, ' from '],
  [/×/g, ' times '],
  [/≥/g, ' at least '],
  [/≤/g, ' at most '],
  [/≈|~(?=\d)/g, ' about '],
  [/\s&\s/g, ' and '],
  [/\s[—–]\s|[—–]/g, ', '],
  [/…/g, '...'],
  [/÷/g, ' divided by '],
  [/−(?=\d)/g, 'minus '],
  [/−/g, '-'],
  [/\s*·\s*/g, ', '],
  [/\s\|\s/g, ', '],
  // Marks a speech engine has no word for: it spells out their Unicode names
  // or switches language, which sounds like gibberish.
  [/[⋮⋯✓✔✕✖✗✘‹›]/g, ' '],
]

// A commit hash or id reads as its first four characters, "b 1 f 7"; in
// brackets, "committed (80f9832)", it is left out.
const HEX_ID = String.raw`(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,64}`
const BRACKETED_ID = new RegExp(String.raw`\s*\(\s*${HEX_ID}(?:-[0-9a-f]+)*(?:-?(?:\.{3}|…))?\s*\)`, 'gi')
const BARE_ID = new RegExp(String.raw`\b(${HEX_ID})(?:-[0-9a-f]+)*(?:-?(?:\.{3}|…))?`, 'gi')

// CLAUDE_CODE_PLUGIN_DIRS reads as "claude code plugin dirs", session_data as
// "session data" and mcpServers as "mcp Servers", not letter by letter.
const SNAKE_CASE = /[\p{L}\p{N}]+(?:_+[\p{L}\p{N}]+)+/gu
const speakSnake = (word: string): string =>
  word
    .split(/_+/)
    .map(part => (part.length > 3 && part === part.toUpperCase() ? part.toLowerCase() : part))
    .join(' ')

// A path reads as its last part: "C:\Users\me\notes\plan.md" is "plan.md". A
// rooted one always does; a relative one when it ends in a file name, so a
// date like 10/24/2026 is left alone. Rooted covers C:\, C:/, C:\\ (escaped
// in JSON) and %LOCALAPPDATA%\.
const ROOTED_PATH = /(^|[\s(])(?:[A-Za-z]:[\\/]+|%\w+%[\\/]+|~[\\/]+|\.{1,2}[\\/]+|\/)(?:[^\s\\/)]+[\\/]+)+([^\s\\/)]+)[\\/]?/g
const RELATIVE_PATH = /(^|[\s(])(?:[\w.@-]+[\\/]){2,}([\w@-]+\.\w{1,6})\b/g

const URL_PATTERN = /\bhttps?:\/\/([^\s/)>\]]+)[^\s)>\]]*/g

// A domain written without http(s)://. Its labels are read with "dot"
// between them, "app.novakitai.app" as "app dot novakitai dot app", since the
// voice otherwise runs them together into one made-up word. Only these
// top-level domains count, so file names (plan.md, next.config.js), decimals
// (1.5x) and versions (2.1.3) are left alone.
const TLD = '(?:app|com|net|org|io|ai|dev|co|uk|ae|me|so|xyz)'
// With a path after it, "novakitai.app/terms", it reads as a link, as a full URL does.
const DOMAIN_WITH_PATH = new RegExp(String.raw`(^|[\s(])((?:[a-z0-9-]+\.)+${TLD})\/[^\s)>\]]*`, 'gi')
const BARE_DOMAIN = new RegExp(String.raw`\b((?:[a-z0-9-]+\.)+${TLD})\b(?![\w/@-])`, 'gi')
const speakDomain = (domain: string): string => domain.replace(/^www\./i, '').split('.').join(' dot ')
// An email address, "jane.doe@gmail.com", as "jane dot doe at gmail dot com".
const EMAIL = new RegExp(String.raw`\b([\w+-]+(?:\.[\w+-]+)*)@((?:[a-z0-9-]+\.)+${TLD})\b`, 'gi')

function cleanInline(line: string, said: { pattern?: RegExp; words: Record<string, string> }): string {
  const spoken = SYMBOLS.reduce(
    (text, [pattern, spoken]) => text.replace(pattern, spoken),
    line
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/<(https?:\/\/[^>]+)>/g, '$1')
      .replace(URL_PATTERN, (_, host: string) => `a link to ${host.replace(/^www\./, '')}`)
      .replace(/<\/?[a-zA-Z][^>]*>/g, '')
      .replace(/`([^`]*)`/g, '$1')
      .replace(EMAIL, (_, name: string, domain: string) => `${name.split('.').join(' dot ')} at ${speakDomain(domain)}`)
      .replace(DOMAIN_WITH_PATH, '$1a link to $2')
      .replace(BARE_DOMAIN, (_, domain: string) => speakDomain(domain))
      // After the domains, so "novakitai" in "app dot novakitai dot app" is found too.
      .replace(said.pattern ?? /(?!)/g, word => {
        const respelling = said.words[word.toLowerCase()]
        return respelling === undefined ? word : speakLetters(respelling)
      })
      .replace(ROOTED_PATH, '$1$2')
      .replace(RELATIVE_PATH, '$1$2')
      .replace(/(^|[\s(])~[\\/]+/g, '$1')
      .replace(BRACKETED_ID, '')
      .replace(BARE_ID, (_, id: string) => id.slice(0, 4).split('').join(' '))
      .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2')
      .replace(/(^|[^\w*])\*(?=\S)([^*]*?\S)\*(?!\w)/g, '$1$2')
      .replace(/(^|\W)_(?=\S)([^_]*?\S)_(?!\w)/g, '$1$2')
      .replace(/~~(.*?)~~/g, '$1')
      .replace(SNAKE_CASE, speakSnake)
      .replace(/(?<=\p{Ll})(?=\p{Lu})/gu, ' ')
      .replace(/\p{Extended_Pictographic}\uFE0F?/gu, ''),
  )

  // A space before a stop goes only where the stop ends a word, so
  // "writes .claude" does not become "writes.claude".
  return spoken.replace(/\s+/g, ' ').replace(/\s+([.,;:!?])(?=\s|$)/g, '$1').trim()
}

// One spoken line per Markdown block line: headings, list items and table rows
// each end in a stop so the voice pauses between them.
function toLines(markdown: string, options: SpeechOptions): string[] {
  const lines: string[] = []
  const said = { pattern: pronunciationPattern(options.pronunciations), words: options.pronunciations ?? {} }
  let fence: string | undefined
  let codeLines = 0

  const closeFence = () => {
    if (options.isCodeSkipped) {
      lines.push(codeLines === 1 ? 'One line of code skipped.' : `${codeLines} lines of code skipped.`)
    }
    fence = undefined
    codeLines = 0
  }

  for (const raw of markdown.replace(/\r\n?/g, '\n').replace(/<!--[\s\S]*?-->/g, '').split('\n')) {
    const fenceMark = /^\s*(`{3,}|~{3,})/.exec(raw)?.[1]
    if (fence !== undefined) {
      if (fenceMark !== undefined && fenceMark[0] === fence[0] && fenceMark.length >= fence.length) {
        closeFence()
      } else {
        codeLines += 1
        if (!options.isCodeSkipped) lines.push(raw.trim())
      }
      continue
    }
    if (fenceMark !== undefined) {
      fence = fenceMark
      continue
    }

    let line = raw.trim()
    if (line === '' || /^([-*_]\s*){3,}$/.test(line) || /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/.test(line)) {
      lines.push('')
      continue
    }
    if (line.startsWith('|')) {
      line = line
        .split('|')
        .map(cell => cell.trim())
        .filter(cell => cell !== '')
        .join(', ')
    }
    line = line
      .replace(/^#{1,6}\s+/, '')
      .replace(/^(>\s?)+/, '')
      .replace(/^([-*+]|\d+[.)])\s+/, '')
      .replace(/^\[[ xX]\]\s+/, '')

    const spoken = cleanInline(line, said)
    if (/[\p{L}\p{N}]/u.test(spoken)) {
      lines.push(/[.!?:;,]$/.test(spoken) ? spoken : `${spoken}.`)
    }
  }
  if (fence !== undefined) closeFence()

  return lines
}

// Splits at a stop followed by a space and a capital, digit or opening quote,
// so "1.5x", "e.g. this" and "file.md" stay whole.
function toSentencesOfLine(line: string): string[] {
  return line
    .replace(/([.!?]+["'”’)\]]*)\s+(?=["'“‘(\[]?[\p{Lu}\p{N}])/gu, '$1\u0000')
    .split('\u0000')
    .map(sentence => sentence.trim())
    .filter(sentence => sentence !== '')
}

export function toSentences(markdown: string, options: SpeechOptions): string[] {
  const sentences: string[] = []
  for (const line of toLines(markdown, options)) {
    if (line === '') continue
    const pieces: string[] = []
    for (const sentence of toSentencesOfLine(line)) {
      const previous = pieces[pieces.length - 1]
      // A very short piece of a line rides with the one before, so the voice
      // keeps flowing; each line still starts a sentence of its own.
      if (previous !== undefined && sentence.length < 12 && previous.length < 200) {
        pieces[pieces.length - 1] = `${previous} ${sentence}`
      } else {
        pieces.push(sentence)
      }
    }
    sentences.push(...pieces)
  }

  return sentences
}

export type UnusualWord = { word: string; sentence: string }

// Words the voice is likely to say wrong, in the order met, each with the
// sentence it was first met in: a capitalised word after a lower-case one (a
// name: Supabase, Vercel), a part of a domain (novakitai in "app
// dot novakitai dot app"), a word mixing letters and digits (gpt4o), and a
// word with letters English rarely runs together (five consonants in a row,
// a q with no u, a trailing "ai"). Ordinary words are left out; Haiku judges
// the rest. Words in `known` (lower case) are skipped.
export function unusualWords(sentences: readonly string[], known: ReadonlySet<string>, limit = 25): UnusualWord[] {
  const found = new Map<string, UnusualWord>()
  for (const sentence of sentences) {
    const tokens = [...sentence.matchAll(/[\p{L}][\p{L}\p{N}'-]*[\p{L}\p{N}]|[\p{L}]/gu)]
    tokens.forEach((match, at) => {
      const word = match[0]
      const key = word.toLowerCase()
      if (word.length < 4 || known.has(key) || found.has(key)) return
      const before = sentence.slice(0, match.index).trimEnd()
      const after = sentence.slice((match.index ?? 0) + word.length).trimStart()
      // A name is capitalised in the middle of running text: the word before it
      // starts lower case, so headings, labels and table cells do not count.
      const previous = tokens[at - 1]?.[0] ?? ''
      const isName = /^\p{Ll}/u.test(previous) && /^\p{Lu}\p{Ll}/u.test(word) && !/[.!?:]$/.test(before)
      const isDomainPart = / dot$/.test(before) || /^dot /.test(after)
      const hasDigits = /\p{N}/u.test(word) && /\p{L}/u.test(word)
      const isOdd = /[bcdfghjklmnpqrstvwxz]{5,}/i.test(word) || /q(?!u)/i.test(word) || /ai$/i.test(word)
      if (isName || isDomainPart || hasDigits || isOdd) found.set(key, { word, sentence })
    })
    if (found.size >= limit) break
  }

  return [...found.values()].slice(0, limit)
}
