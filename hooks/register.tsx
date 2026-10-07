import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { ContextBar, RequestRow, Requests } from '../types'

type Settings = {
  enabled: boolean
  threshold: number
  autoClear: boolean
  autoResume: boolean
  showBar: boolean
  cacheTtlMinutes: number
}

type Pending = { path: string; sessionId: string; savedAt: number }

const DEFAULTS: Settings = { enabled: true, threshold: 50, autoClear: true, autoResume: false, showBar: true, cacheTtlMinutes: 60 }

const bar = atom({ plugin: 'auto-handoff', key: 'bar' } as const, {
  percent: null,
  threshold: DEFAULTS.threshold,
  isEnabled: DEFAULTS.enabled,
  isShown: DEFAULTS.showBar,
} satisfies ContextBar)

const requestsRef = { plugin: 'auto-handoff', key: 'requests' } as const
const INITIAL_REQUESTS: Requests = { rows: [], ttlMinutes: DEFAULTS.cacheTtlMinutes, tick: 0 }
const requests = atom(requestsRef, INITIAL_REQUESTS)

const MAX_ROWS = 200
const TICK_MS = 30_000
const BAR_MAX_CELLS = 40
const BAR_MIN_CELLS = 10
const SVG_WIDTH = 300
const SVG_HEIGHT = 18
const SVG_COLORS = { green: '#2da44e', yellow: '#d4a72c', red: '#e5484d' } as const
const MAX_PENDING_AGE_MS = 6 * 60 * 60 * 1000
const HANDOFF_FILE = '.claude/handoff.md'
const KEPT_DIR = '.claude/handoffs'
const KEPT_SLOTS = 5

const SUMMARY_PROMPT = `Write a handoff for a fresh Claude Code session that will continue this work with no memory of this conversation.
Use exactly these sections, in markdown:

## Goal
What the user is trying to achieve, in their terms.

## State
What is done, what is half-done, and what is broken right now.

## Decisions
Choices made and the reason for each, so they are not re-litigated.

## Open tasks
A checklist, in the order to do them. Mark the very next step.

## Key files
Paths touched or needed, one line each on why.

## Gotchas
Commands that work, dead ends already tried, anything surprising.

Be specific and terse. Output only the handoff, no preamble.`

// Module variables start over on a hot reload; the host's store does not.
let isBusy = false
let handedOffSession: string | undefined

const loadSettings = async ($: any): Promise<Settings> => ({
  ...DEFAULTS,
  ...((await $.store.get('settings')) as Partial<Settings> | undefined),
})

// Keeps the bar's atom in step with the stored settings; the write redraws the band.
const syncBar = ($: any, settings: Settings) =>
  update($, bar, (b: ContextBar) =>
    b.threshold === settings.threshold && b.isEnabled === settings.enabled && b.isShown === settings.showBar
      ? b
      : { ...b, threshold: settings.threshold, isEnabled: settings.enabled, isShown: settings.showBar },
  )

const saveSettings = async ($: any, settings: Settings) => {
  await $.store.set('settings', settings)
  await syncBar($, settings)
  await update($, requests, (r: Requests) =>
    r.ttlMinutes === settings.cacheTtlMinutes ? r : { ...r, ttlMinutes: settings.cacheTtlMinutes },
  )
}

// Reads the live context fill into the bar; a write only when it has moved.
const refreshBar = async ($: any): Promise<void> => {
  const { context } = await $.session.usage()
  const percent: number | null = context.percent === undefined ? null : Math.round(context.percent)
  await update($, bar, (b: ContextBar) => (b.percent === percent ? b : { ...b, percent }))
}

const saveSettingsView = async ($: any, settings: Settings) => {
  await syncBar($, settings)
  await update($, requests, (r: Requests) =>
    r.ttlMinutes === settings.cacheTtlMinutes ? r : { ...r, ttlMinutes: settings.cacheTtlMinutes },
  )
}

const tickCountdown = async ($: any): Promise<void> => {
  const now: number = await $.clock.now()
  const tick = Math.floor(now / TICK_MS)
  await update($, requests, (r: Requests) => (r.tick === tick ? r : { ...r, tick }))
}

// Says where a handoff stands: a toast, a transcript notice the model never reads, and a stored record.
const say = async ($: any, text: string): Promise<void> => {
  $.ui.toast(text)
  await $.session.append({ message: { type: 'system', content: [{ type: 'text', text: `auto-handoff: ${text}` }] } }).catch(() => undefined)
  const at: number = await $.clock.now()
  await $.store.set('lastHandoff', { at, text }).catch(() => undefined)
}

const quietly = ($: any, work: Promise<unknown>): void => {
  void work.catch((error: unknown) => $.ui.toast(`Auto-handoff bar: ${String(error)}`))
}

const kilo = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k` : String(n))
const promptTokens = (r: RequestRow): number => r.input + r.cacheRead + r.cacheWrite
const hitPercent = (r: RequestRow): number => {
  const total = promptTokens(r)
  return total === 0 ? 0 : Math.round((r.cacheRead / total) * 100)
}
const clock = (ms: number): string => {
  const d = new Date(ms)
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join(':')
}
const span = (ms: number): string => {
  const minutes = Math.floor(ms / 60000)
  if (minutes < 1) return '<1m'
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`
}

const lastMain = (rows: readonly RequestRow[]): RequestRow | undefined =>
  [...rows].reverse().find(r => r.agentId === undefined)

// Milliseconds the prompt cache has left after the main thread's last request; undefined with none yet.
const cacheLeft = (rows: readonly RequestRow[], ttlMinutes: number, now: number): number | undefined => {
  const last = lastMain(rows)
  return last === undefined ? undefined : last.at + ttlMinutes * 60000 - now
}

const getRequests = async ($: any): Promise<Requests> => {
  const { value } = await $.state.get(requestsRef)
  return value ?? INITIAL_REQUESTS
}

const recordRequest = async ($: any, agentId: string | undefined, usage: any): Promise<void> => {
  const at: number = await $.clock.now()
  const row: RequestRow = {
    at,
    model: String(usage.model),
    ...(agentId === undefined ? {} : { agentId }),
    input: usage.input_tokens,
    output: usage.output_tokens,
    cacheRead: usage.cache_read_input_tokens,
    cacheWrite: usage.cache_creation_input_tokens,
  }
  await update($, requests, (r: Requests) => ({ ...r, rows: [...r.rows, row].slice(-MAX_ROWS) }))
}

const tokenReport = (r: Requests, now: number): string => {
  if (r.rows.length === 0) return 'No requests recorded yet in this session.'
  const sum = (rows: RequestRow[]) =>
    rows.reduce(
      (t, x) => ({ prompt: t.prompt + promptTokens(x), read: t.read + x.cacheRead, out: t.out + x.output }),
      { prompt: 0, read: 0, out: 0 },
    )
  const main = r.rows.filter(x => x.agentId === undefined)
  const sub = r.rows.filter(x => x.agentId !== undefined)
  const m = sum(main)
  const sb = sum(sub)
  const left = cacheLeft(r.rows, r.ttlMinutes, now)
  const lines = r.rows.slice(-10).map(
    x =>
      `${clock(x.at)}  Input: ${kilo(promptTokens(x))} (${hitPercent(x)}% cached, ${kilo(x.input + x.cacheWrite)} new) · Output: ${kilo(x.output)}` +
      ` · ${x.model}${x.agentId === undefined ? '' : ' · subagent'}`,
  )
  return [
    `Last ${lines.length} of ${r.rows.length} requests:`,
    ...lines,
    `Main thread: ${main.length} requests, ${kilo(m.prompt)} prompt tokens sent (${kilo(m.read)} from cache), ${kilo(m.out)} out`,
    ...(sub.length === 0 ? [] : [`Subagents: ${sub.length} requests, ${kilo(sb.prompt)} prompt tokens, ${kilo(sb.out)} out`]),
    left === undefined
      ? 'Cache: no main-thread request yet'
      : left > 0
        ? `Cache: warm, ${span(left)} left of ${r.ttlMinutes}m`
        : `Cache: cold for ${span(-left)}`,
  ].join('\n')
}

const summarize = async ($: any): Promise<string | undefined> => {
  const forked = await $.model.fork({ prompt: SUMMARY_PROMPT })
  if (forked.isAnswered && forked.text.trim() !== '') return forked.text

  const messages = await $.session.messages()
  const transcript = messages
    .slice(-60)
    .map((m: any) => `${m.role.toUpperCase()}: ${m.text}`)
    .join('\n\n')
    .slice(-60000)
  const completed = await $.model.complete({
    model: 'sonnet',
    prompt: `${SUMMARY_PROMPT}\n\n<transcript>\n${transcript}\n</transcript>`,
    maxTokens: 4000,
  })
  return completed.isAnswered && completed.text.trim() !== '' ? completed.text : undefined
}

const slash = (path: string): string => path.replace(/\\/g, '/').replace(/\/$/, '')

// A session started with no project folder works in a scratch workspace that is deleted with it.
const isScratch = (root: string): boolean => root.includes('/scratch-workspaces/')

// The newest KEPT_SLOTS handoffs live in the home folder; there is no delete, so a full set reuses the oldest slot.
const keepCopy = async ($: any, content: string): Promise<string | undefined> => {
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  if (typeof home !== 'string' || home === '') return undefined
  const dir = `${slash(home)}/${KEPT_DIR}`
  const entries: { name: string; mtimeMs: number }[] = await $.fs.list(dir).catch(() => [])
  const slots = Array.from({ length: KEPT_SLOTS }, (_, i) => `handoff-${i + 1}.md`)
  const taken = new Map(entries.map(entry => [entry.name, entry.mtimeMs]))
  const free = slots.find(name => !taken.has(name))
  const oldest = [...slots].sort((a, b) => (taken.get(a) ?? 0) - (taken.get(b) ?? 0))[0]
  const path = `${dir}/${free ?? oldest}`
  await $.fs.write(path, content)
  return path
}

const handoff = async ($: any, why: string): Promise<string> => {
  if (isBusy) return 'A handoff is already running.'
  isBusy = true
  try {
    const settings = await loadSettings($)
    await say(
      $,
      `${why}. Writing a handoff summary` +
        (settings.autoClear ? ', then starting a fresh session that picks up where this one left off.' : '. Run /clear afterwards to load it into a fresh session.'),
    )
    const seen = await getRequests($)
    const left = cacheLeft(seen.rows, seen.ttlMinutes, await $.clock.now())
    const last = lastMain(seen.rows)
    if (left !== undefined && left <= 0 && last !== undefined) {
      $.ui.toast(`Auto-handoff: the prompt cache is cold, so the summary re-bills about ${kilo(promptTokens(last))} tokens.`)
    }
    const text = await summarize($)
    if (text === undefined) {
      await say($, 'could not write a summary, so nothing was cleared.')
      return 'Could not write a summary; the session is untouched.'
    }

    const sessionId: string = await $.session.id()
    const root = slash(String(await $.session.root()))
    const now: number = await $.clock.now()
    const header = `<!-- auto-handoff: ${new Date(now).toISOString()} · ${why} · from session ${sessionId} -->\n\n`
    const content = header + text.trim() + '\n'
    // A project keeps its own copy; the home copy survives a scratch workspace and keeps the last few.
    const projectPath = isScratch(root) ? undefined : `${root}/${HANDOFF_FILE}`
    if (projectPath !== undefined) await $.fs.write(projectPath, content)
    const keptPath = await keepCopy($, content).catch(() => undefined)
    const path = projectPath ?? keptPath
    if (path === undefined) {
      await say($, 'could not save the handoff anywhere, so nothing was cleared.')
      return 'Could not save the handoff; the session is untouched.'
    }
    await $.store.set('pending', { path, sessionId, savedAt: now } satisfies Pending)
    handedOffSession = sessionId

    if (!settings.autoClear) {
      await say($, `handoff saved to ${path}. Run /clear and it loads into the new session.`)
      return `Handoff saved to ${path}. Run /clear to start fresh with it.`
    }

    await say($, `handoff saved to ${path}. Starting a fresh session…`)
    try {
      await $.command.run({ command: 'clear' })
    } catch (error) {
      await say($, `handoff saved, but /clear failed (${String(error)}). Run /clear yourself.`)
      return `Handoff saved to ${path}, but /clear failed. Run /clear yourself.`
    }
    if (settings.autoResume) {
      void $.prompt.submit({ text: 'Continue from the handoff notes in your context.' })
    }
    return `Handoff saved to ${path}; session cleared.`
  } finally {
    isBusy = false
  }
}

const checkContext = async ($: any): Promise<void> => {
  const settings = await loadSettings($)
  if (!settings.enabled) return
  const sessionId: string = await $.session.id()
  if (handedOffSession === sessionId) return
  const { context } = await $.session.usage()
  if ((context.percent ?? 0) < settings.threshold) return
  await handoff($, `context at ${Math.round(context.percent)}%`)
}

const describe = (s: Settings) =>
  `auto-handoff is ${s.enabled ? 'on' : 'off'} · threshold ${s.threshold}% · ` +
  `clear automatically: ${s.autoClear ? 'yes' : 'no'} · resume automatically: ${s.autoResume ? 'yes' : 'no'} · ` +
  `bar: ${s.showBar ? 'shown' : 'hidden'} · cache ttl: ${s.cacheTtlMinutes}m`

const USAGE =
  'Usage: /auto-handoff [on|off|status|<percent>|clear on|off|resume on|off|bar on|off|ttl <minutes>|tokens]'

// Green while well under the mark, yellow as it nears, red once past it.
const fillColor = (percent: number, threshold: number): 'red' | 'yellow' | 'green' =>
  percent >= threshold ? 'red' : percent >= threshold * 0.8 ? 'yellow' : 'green'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'auto-handoff',
      description: 'Configure auto-handoff: on, off, a threshold percent, clear on|off, resume on|off',
    })
    await $.command.register({
      name: 'handoff-now',
      description: 'Write the handoff file now, and clear the session when auto-clear is on',
    })
    quietly($, loadSettings($).then(settings => saveSettingsView($, settings)).then(() => refreshBar($)))
    // Redraws the cache countdown; timers die with a reload and start again here.
    $.clock.every(TICK_MS, () => {
      quietly($, tickCountdown($))
    })
    return next(e)
  })

  // One row per model request, from the usage the API reported; passes the stream through.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    if (result.usage !== null) await recordRequest($, e.agentId, result.usage).catch((error: unknown) => $.ui.toast(`Auto-handoff tokens: ${String(error)}`))
    return result
  })

  // Each tool call follows a model response, so the bar fills while a long turn runs.
  on('tool.call', ($, e, next) => {
    if (e.agentId === undefined) quietly($, refreshBar($))
    return next(e)
  })

  // The turn has ended: the session is idle enough for a fork and a queued /clear.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined || e.reason !== 'answer') return result
    quietly($, refreshBar($))
    void checkContext($).catch((error: unknown) => {
      void say($, `failed: ${String(error)}`)
    })
    return result
  })

  // The first prompt of a conversation carries the handoff the previous session left.
  on('prompt.context', async ($, e, next) => {
    const result = await next(e)
    const pending = (await $.store.get('pending')) as Pending | undefined
    if (pending === undefined) return result
    const now: number = await $.clock.now()
    const isStale = now - pending.savedAt > MAX_PENDING_AGE_MS
    const isSameSession = pending.sessionId === (await $.session.id())
    if (isStale) await $.store.delete('pending')
    if (isStale || isSameSession) return result

    const text = await $.fs.read(pending.path).catch(() => undefined)
    await $.store.delete('pending')
    if (typeof text !== 'string') return result
    $.ui.toast('Loaded the handoff from your previous session.')
    return {
      ...result,
      blocks: [
        ...result.blocks,
        {
          name: 'handoff',
          text:
            'Handoff from the previous session, which ran out of room. ' +
            'Treat it as the starting state and continue the work it describes.\n\n' +
            text,
        },
      ],
    }
  })

  // Detached: a command hook may not wait on a /clear queued behind itself.
  on('command.run', { command: 'handoff-now' }, async $ => {
    void handoff($, 'requested with /handoff-now').then(
      (outcome: string) => say($, outcome),
      (error: unknown) => say($, `failed: ${String(error)}`),
    )
    return { text: 'Writing the handoff…' }
  })

  on('command.run', { command: 'auto-handoff' }, async ($, e) => {
    const settings = await loadSettings($)
    const words = e.args.trim().toLowerCase().split(/\s+/).filter(Boolean)
    const [first, second] = words

    if (first === 'tokens') return { text: tokenReport(await getRequests($), await $.clock.now()) }
    if (first === 'status' || first === undefined) {
      const last = (await $.store.get('lastHandoff')) as { at: number; text: string } | undefined
      const when = last === undefined ? '' : ` · last handoff ${clock(last.at)}: ${last.text}`
      return { text: describe(settings) + when }
    }
    if (first === 'on' || first === 'off') settings.enabled = first === 'on'
    else if (first === 'bar' && (second === 'on' || second === 'off')) settings.showBar = second === 'on'
    else if (first === 'ttl') {
      const minutes = Number(second)
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 120) {
        return { text: 'Cache ttl must be 1 to 120 minutes (the API gives 5 or 60).' }
      }
      settings.cacheTtlMinutes = minutes
    }
    else if ((first === 'clear' || first === 'resume') && (second === 'on' || second === 'off')) {
      if (first === 'clear') settings.autoClear = second === 'on'
      else settings.autoResume = second === 'on'
    } else if (/^\d+%?$/.test(first)) {
      const percent = parseInt(first, 10)
      if (percent < 5 || percent > 95) return { text: 'Threshold must be between 5 and 95.' }
      settings.threshold = percent
    } else return { text: USAGE }

    await saveSettings($, settings)
    handedOffSession = undefined
    return { text: describe(settings) }
  })

  // The bar: cells filled for the context used, a mark at the handoff threshold.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const state = await read($, bar)
    if (e.props.hasSurvey || !state.isShown) return next(e)

    const table = $.ui.resolve(e)
    const { Box, Text } = table
    const usage = await read($, requests)
    const now: number = await $.clock.now()
    const left = cacheLeft(usage.rows, usage.ttlMinutes, now)
    const last = lastMain(usage.rows)
    const cacheColor = left === undefined ? undefined : left <= 0 ? 'red' : left < 5 * 60000 ? 'yellow' : 'green'
    const cacheText =
      left === undefined ? 'Cache: no request yet' : left > 0 ? `Cache warm ${span(left)} left` : `Cache cold ${span(-left)}`
    const fresh = last === undefined ? 0 : last.input + last.cacheWrite
    // The cache state sits at the right of the bar's row; the last request's tokens take the row below.
    const cacheLine = (
      <Text color={cacheColor} dimColor={cacheColor === undefined}>
        {cacheText}
      </Text>
    )
    const requestLine =
      last === undefined ? null : (
        <Text dimColor>
          {`Last request · Input: ${kilo(promptTokens(last))} (${hitPercent(last)}% cached, ${kilo(fresh)} new) · Output: ${kilo(last.output)}`}
        </Text>
      )
    const layout = (barRow: any) => (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          {barRow}
          {cacheLine}
        </Box>
        {requestLine}
      </Box>
    )
    const percent = state.percent ?? 0
    const label = state.percent === null ? ' --%' : ` ${String(percent).padStart(2)}%`
    const tail = state.isEnabled ? `  handoff at ${state.threshold}%` : '  handoff off'

    // The desktop draws proportional text, so a row of block glyphs would not
    // line up: it gets a real vector bar, 0-100 across, with the red line.
    if (e.surface === 'desktop' && 'Svg' in table) {
      const { Svg } = table
      const color = SVG_COLORS[fillColor(percent, state.threshold)]
      const isPast = state.isEnabled && percent >= state.threshold
      const fillWidth = Math.max(0, Math.min(100, percent)) * (SVG_WIDTH / 100)
      const markX = Math.min(SVG_WIDTH - 1, Math.max(1, state.threshold * (SVG_WIDTH / 100)))
      const source =
        `<svg xmlns="http://www.w3.org/2000/svg" width="${SVG_WIDTH}" height="${SVG_HEIGHT}" viewBox="0 0 ${SVG_WIDTH} ${SVG_HEIGHT}">` +
        `<rect x="0" y="5" width="${SVG_WIDTH}" height="8" rx="4" fill="#8a8a8a" fill-opacity="0.3"/>` +
        (fillWidth > 0 ? `<rect x="0" y="5" width="${fillWidth}" height="8" rx="4" fill="${color}"/>` : '') +
        (state.isEnabled
          ? `<rect x="${markX - 2}" y="0" width="4" height="${SVG_HEIGHT}" fill="#ffffff" fill-opacity="0.85"/>` +
            `<rect x="${markX - 1}" y="0" width="2" height="${SVG_HEIGHT}" fill="${SVG_COLORS.red}"/>`
          : '') +
        `</svg>`

      return layout(
        <Box flexDirection="row" alignItems="center">
          <Text dimColor>Context </Text>
          <Svg
            source={source}
            alt={`Context ${state.percent === null ? 'unknown' : `${percent}%`}, handoff at ${state.threshold}%`}
            width={SVG_WIDTH}
            height={SVG_HEIGHT}
          />
          <Text color={isPast ? 'red' : undefined} bold={isPast}>
            {label}
          </Text>
          <Text dimColor>{tail}</Text>
        </Box>,
      )
    }
    const cells = Math.max(
      BAR_MIN_CELLS,
      Math.min(BAR_MAX_CELLS, e.props.bodyColumns - 'Context '.length - label.length - tail.length - 2),
    )

    const filled = Math.round((percent / 100) * cells)
    const mark = Math.min(cells - 1, Math.round((state.threshold / 100) * cells))
    const color = fillColor(percent, state.threshold)
    const isPast = state.isEnabled && percent >= state.threshold

    // Cells [from, to): filled ones in the fill color, the rest dim.
    const run = (from: number, to: number) => {
      const fillCount = Math.max(0, Math.min(to, filled) - from)
      const emptyCount = Math.max(0, to - from - fillCount)
      return (
        <Box flexDirection="row">
          <Text color={color}>{'█'.repeat(fillCount)}</Text>
          <Text dimColor>{'░'.repeat(emptyCount)}</Text>
        </Box>
      )
    }

    return layout(
      <Box flexDirection="row">
        <Text dimColor>Context </Text>
        {run(0, mark)}
        {state.isEnabled ? (
          <Text color={isPast ? 'white' : 'red'} bold>
            ┃
          </Text>
        ) : (
          run(mark, mark + 1)
        )}
        {run(mark + 1, cells)}
        <Text color={color} bold={isPast}>
          {label}
        </Text>
        <Text dimColor>{tail}</Text>
      </Box>,
    )
  })
}
