import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { ContextBar, Keepwarm, RequestRow, Requests } from '../types'
import {
  BIG_TOKENS,
  MAX_PINGS,
  MAX_WINDOW_MS,
  MIN_EVERY_MS,
  PING_PROMPT,
  coldRewriteCost,
  defaultEveryMs,
  effectiveEveryMs,
  isWarmPing,
  parseDuration,
  pingCost,
  priceOf,
  usd,
  warmReadCost,
} from './keepwarm'

type Settings = {
  enabled: boolean
  threshold: number
  autoClear: boolean
  autoResume: boolean
  showBar: boolean
  cacheTtlMinutes: number
}

type Pending = { path: string; sessionId: string; root: string; savedAt: number }

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

const keepwarmRef = { plugin: 'auto-handoff', key: 'keepwarm' } as const
const INITIAL_KEEPWARM: Keepwarm = { until: null, customEveryMs: null, pings: 0, spent: 0, lastPing: null, stopped: null }
const keepwarm = atom(keepwarmRef, INITIAL_KEEPWARM)

const MAX_ROWS = 200
const TICK_MS = 30_000
const BAR_MAX_CELLS = 40
const BAR_MIN_CELLS = 10
const SVG_WIDTH = 300
const SVG_HEIGHT = 18
const SVG_COLORS = { green: '#2da44e', yellow: '#d4a72c', red: '#e5484d' } as const
const MAX_PENDING_AGE_MS = 6 * 60 * 60 * 1000
const HANDOFFS_DIR = '.claude/handoffs'
const KEPT_DIR = '.claude/handoffs'
const KEPT_SLOTS = 5

// The store is shared by every session, so each project keeps its own pending handoff.
const pendingKey = (root: string): string => `pending:${root}`

// Every session that has handed off, newest last; one id in one key let two sessions re-arm each other.
const MAX_HANDED_OFF = 20
const handedOffIds = async ($: any): Promise<string[]> => {
  const ids = await $.store.get('handedOff')
  return Array.isArray(ids) ? ids : []
}
const markHandedOff = async ($: any, sessionId: string): Promise<void> => {
  const ids = await handedOffIds($)
  await $.store.set('handedOff', [...ids.filter(id => id !== sessionId), sessionId].slice(-MAX_HANDED_OFF))
}

const pad = (n: number) => String(n).padStart(2, '0')
// Local time, then the session's first 8 characters, so two sessions in the same second never share a file.
const handoffFileName = (now: number, sessionId: string): string => {
  const d = new Date(now)
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  return `${stamp}-auto-handoff-${sessionId.slice(0, 8)}.md`
}

const SUMMARY_PROMPT = `Write a handoff for a fresh Claude Code session that will continue this work with no memory of this conversation.
Use exactly these sections, in markdown, starting with the first heading (no frontmatter, no title):

## Summary
2-3 sentences: what this work is about, its current status, who it is for.

## Current State
Checkboxes: done, half-done, not started. Say what is broken right now.

## Key Decisions
Choices made and the reason for each, so they are not re-litigated.

## Open Issues
Blockers, known bugs, dead ends already tried.

## Artifacts
Files the next session needs, as file:line, one line each on why.

## Next Steps
Ordered, actionable. Item 1 is the very next thing to do.

Prefer file:line references over pasted code. Be specific and terse. Output only the handoff.`

// Module variables start over on a hot reload; the host's store does not.
let isBusy = false
// Counts prompts this process has seen; a handoff compares before and after its summary.
let promptCount = 0
// Set once the model was told mid-turn to wrap up; reset when the turn ends.
let isNudged = false
// The session told it is waiting for background agents, so the notice is said once.
let waitingFor: string | undefined
// The keepwarm timer: one ping, or the end of the window. A reload cancels it; session.start arms it again.
let pingTimer: { cancel: () => void } | undefined
// The session a keepwarm window was armed in, so its stored window is deleted even after /clear gives a new id.
let armedSession: string | undefined
// A compaction or /clear replaced the transcript: nothing of it is cached until the next request writes it.
let isTranscriptNew = false
const PING_RETRY_MS = 30_000

// A /clear ends every agent still working, so a handoff waits for these.
const BUSY_STATUSES = new Set(['pending', 'running', 'waiting'])
type ActiveAgent = { id: string; description: string; type: string; status: string; name?: string }
const activeAgents = async ($: any): Promise<ActiveAgent[]> => {
  const agents: ActiveAgent[] = await $.agent.list().catch(() => [])
  return agents.filter(agent => BUSY_STATUSES.has(agent.status))
}
const agentLine = (agent: ActiveAgent): string =>
  `- ${agent.description} (${agent.type}, ${agent.status}, id ${agent.id}${agent.name === undefined ? '' : `, name ${agent.name}`})`
const agentsPhrase = (count: number): string => (count === 1 ? '1 background agent is' : `${count} background agents are`)

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

const quietly = ($: any, work: Promise<unknown>, label = 'bar'): void => {
  void work.catch((error: unknown) => $.ui.toast(`Auto-handoff ${label}: ${String(error)}`))
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

// Milliseconds the prompt cache has left after the main thread's last request, or after a keepwarm
// ping if that came later; undefined with neither yet.
const cacheLeft = (rows: readonly RequestRow[], ttlMinutes: number, now: number, pingedAt?: number): number | undefined => {
  const last = lastMain(rows)
  if (last === undefined && pingedAt === undefined) return undefined
  return Math.max(last?.at ?? 0, pingedAt ?? 0) + ttlMinutes * 60000 - now
}

const getRequests = async ($: any): Promise<Requests> => {
  const { value } = await $.state.get(requestsRef)
  return value ?? INITIAL_REQUESTS
}

const getKeepwarm = async ($: any): Promise<Keepwarm> => {
  const { value } = await $.state.get(keepwarmRef)
  return value ?? INITIAL_KEEPWARM
}

// The keepwarm window is stored per session: the store is shared, and a second session must not inherit or end it.
const keepwarmKey = (sessionId: string): string => `keepwarm:${sessionId}`

type CacheView = {
  kw: Keepwarm
  now: number
  ttlMinutes: number
  /** The main thread's model, for prices. */
  model: string | undefined
  /** Milliseconds the cache has left; undefined when nothing is cached yet (no request, or a new transcript). */
  left: number | undefined
  /** Milliseconds between the cache's last use and a ping. */
  every: number
}

const readCache = async ($: any): Promise<CacheView> => {
  const settings = await loadSettings($)
  const kw = await getKeepwarm($)
  const seen = await getRequests($)
  const now: number = await $.clock.now()
  return {
    kw,
    now,
    ttlMinutes: settings.cacheTtlMinutes,
    model: lastMain(seen.rows)?.model,
    left: isTranscriptNew ? undefined : cacheLeft(seen.rows, settings.cacheTtlMinutes, now, kw.lastPing?.at),
    every: effectiveEveryMs(kw.customEveryMs ?? undefined, settings.cacheTtlMinutes),
  }
}

// One line on where the window stands; undefined when keepwarm is off.
const keepwarmLine = (c: CacheView): string | undefined => {
  const { kw } = c
  if (kw.stopped !== null) return `Keepwarm stopped: ${kw.stopped}`
  if (kw.until === null || kw.until <= c.now) return undefined
  const next = isTranscriptNew
    ? 'waiting for the first request after the compaction or /clear'
    : c.left === undefined
      ? 'waiting for the first request'
      : c.left <= 0
        ? 'the cache is cold, so no ping until the next request'
        : `next ping in ${span(Math.max(0, c.left - c.ttlMinutes * 60000 + c.every))}`
  const spent = kw.pings === 0 ? '' : ` · ${kw.pings} ping${kw.pings === 1 ? '' : 's'}, about ${usd(kw.spent)}`
  const last = kw.lastPing === null ? '' : ` · last ping read ${kilo(kw.lastPing.read)} (${usd(kw.lastPing.cost ?? undefined)})`
  return `Keepwarm ${span(kw.until - c.now)} left · ${next}${spent}${last}`
}

const disarmKeepwarm = (): void => {
  pingTimer?.cancel()
  pingTimer = undefined
}

// Ends the window. A reason is toasted and shown in the bar (`remember`); null is a quiet end
// (/keepwarm off, the window's own end). Only a window that was on says anything.
const stopKeepwarm = async ($: any, why: string | null, remember = true): Promise<void> => {
  disarmKeepwarm()
  const wasOn = (await getKeepwarm($)).until !== null
  for (const id of new Set([armedSession, await $.session.id()])) {
    if (typeof id === 'string') await $.store.delete(keepwarmKey(id))
  }
  armedSession = undefined
  if (why !== null && !wasOn) return
  await update($, keepwarm, (k: Keepwarm) => (why === null || !remember ? INITIAL_KEEPWARM : { ...k, until: null, stopped: why }))
  if (why !== null) $.ui.toast(`Auto-handoff keepwarm stopped: ${why}.`)
}

// Schedules the next ping, or only the end of the window when there is nothing warm to refresh.
const armKeepwarm = async ($: any): Promise<void> => {
  disarmKeepwarm()
  const c = await readCache($)
  if (c.kw.until === null) return
  if (c.now >= c.kw.until) return stopKeepwarm($, null)
  const wait = (ms: number) => {
    pingTimer = $.clock.after(ms, () => quietly($, pingKeepwarm($), 'keepwarm'))
  }
  // A cold cache cannot be refreshed, only rewritten, and that is the next request's to pay for.
  if (c.left === undefined || c.left <= 0) return wait(c.kw.until - c.now)
  const lastUse = c.now + c.left - c.ttlMinutes * 60000
  wait(Math.min(c.kw.until - c.now, c.left, Math.max(1000, lastUse + c.every - c.now)))
}

const FAILURES: Record<string, string> = {
  'nothing-to-fork': 'there is no conversation to warm yet',
  'empty-reply': 'the ping got no text back',
  aborted: 'the ping was interrupted',
}

// A ping is a fork over the cached transcript with a one-word prompt. It is not a turn: nothing is
// appended to the conversation, no prompt reaches the model's context, and neither the context
// bar nor the handoff threshold sees it.
const pingKeepwarm = async ($: any): Promise<void> => {
  pingTimer = undefined
  const c = await readCache($)
  if (c.kw.until === null) return
  const lastUse = c.left === undefined ? 0 : c.now + c.left - c.ttlMinutes * 60000
  // The window ended, the cache lapsed, or a request got in first and re-armed the timer: this call is stale.
  if (c.now >= c.kw.until || c.left === undefined || c.left <= 0 || c.now - lastUse < c.every - 1000) return armKeepwarm($)
  // A handoff is writing its summary from this cache, which warms it just the same.
  if (isBusy) {
    pingTimer = $.clock.after(PING_RETRY_MS, () => quietly($, pingKeepwarm($), 'keepwarm'))
    return
  }
  if (c.kw.pings >= MAX_PINGS) return stopKeepwarm($, `it reached the ${MAX_PINGS}-ping limit for one window`)

  let reply: any
  try {
    reply = await $.model.fork({ prompt: PING_PROMPT })
  } catch (error) {
    return stopKeepwarm($, `the ping failed (${String(error)})`)
  }
  // Older releases answer null when the snapshot was cold or the call failed.
  if (reply === null || reply === undefined) return stopKeepwarm($, 'the engine did not send the ping')
  if (!reply.isAnswered) {
    const status = reply.reason === 'api-error' && reply.status != null ? ` (${reply.status})` : ''
    return stopKeepwarm($, reply.reason === 'api-error' ? `the API call failed${status}` : (FAILURES[reply.reason] ?? 'the ping failed'))
  }

  const u = reply.usage
  const cost = pingCost(u, priceOf(c.model))
  const at: number = await $.clock.now()
  await update($, keepwarm, (k: Keepwarm) => ({
    ...k,
    pings: k.pings + 1,
    spent: k.spent + (cost ?? 0),
    lastPing: { at, read: u.cache_read_input_tokens, write: u.cache_creation_input_tokens, cost: cost ?? null },
  }))
  // A cold read means the prefix had already broken: the ping paid for a rewrite, so more would pay again.
  if (!isWarmPing(u)) {
    return stopKeepwarm(
      $,
      `a ping read ${kilo(u.cache_read_input_tokens)} and wrote ${kilo(u.cache_creation_input_tokens)} tokens (${usd(cost)}), so the cache was already gone`,
    )
  }
  await armKeepwarm($)
}

// Opens the window, replacing one that was open.
const startKeepwarm = async ($: any, windowMs: number, customEveryMs: number | null): Promise<void> => {
  const now: number = await $.clock.now()
  const sessionId: string = await $.session.id()
  armedSession = sessionId
  await $.store.set(keepwarmKey(sessionId), { until: now + windowMs, customEveryMs })
  await update($, keepwarm, () => ({ ...INITIAL_KEEPWARM, until: now + windowMs, customEveryMs }))
  await armKeepwarm($)
}

// A window outlives a hot reload and a restart of the same session; the timer does not.
const restoreKeepwarm = async ($: any): Promise<void> => {
  const sessionId: string = await $.session.id()
  const saved = (await $.store.get(keepwarmKey(sessionId))) as { until?: number; customEveryMs?: number | null } | undefined
  if (saved === undefined) return
  const now: number = await $.clock.now()
  if (typeof saved.until !== 'number' || saved.until <= now) {
    await $.store.delete(keepwarmKey(sessionId))
    return
  }
  armedSession = sessionId
  await update($, keepwarm, (k: Keepwarm) =>
    k.until === saved.until ? k : { ...INITIAL_KEEPWARM, until: saved.until!, customEveryMs: saved.customEveryMs ?? null },
  )
  await armKeepwarm($)
}

// What a send into a cold cache will cost, for a context big enough to matter; undefined when the cache is warm.
const coldSendNote = async ($: any): Promise<string | undefined> => {
  const c = await readCache($)
  const last = lastMain((await getRequests($)).rows)
  if (last === undefined || c.left === undefined || c.left > 0) return undefined
  const tokens = promptTokens(last)
  if (tokens < BIG_TOKENS) return undefined
  const cold = coldRewriteCost(tokens, last.model, c.ttlMinutes)
  const warm = warmReadCost(tokens, last.model)
  return (
    `the prompt cache went cold ${span(-c.left)} ago. Sending this re-writes up to ${tokens.toLocaleString('en-US')} tokens` +
    (cold === undefined ? '' : ` = about ${usd(cold)}`) +
    (warm === undefined ? '' : ` (a warm turn would have cost about ${usd(warm)})`) +
    '. Sending anyway; /keepwarm <duration> holds the cache warm during a break.'
  )
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

const tokenReport = (r: Requests, now: number, kw: Keepwarm): string => {
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
  const left = cacheLeft(r.rows, r.ttlMinutes, now, kw.lastPing?.at)
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
    // Pings are not requests of the conversation, so they are not in the rows above.
    ...(kw.pings === 0 ? [] : [`Keepwarm: ${kw.pings} ping${kw.pings === 1 ? '' : 's'} this window, about ${usd(kw.spent)}`]),
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
  // Managed settings can pin the model, so the fallback may be refused outright.
  let completed: { isAnswered: boolean; text: string }
  try {
    completed = await $.model.complete({
      model: 'sonnet',
      prompt: `${SUMMARY_PROMPT}\n\n<transcript>\n${transcript}\n</transcript>`,
      maxTokens: 4000,
    })
  } catch (error) {
    throw new Error(`the fallback summary model was refused (${String(error)})`)
  }
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
  const promptsBefore = promptCount
  try {
    const settings = await loadSettings($)
    await say(
      $,
      `${why}. Writing a handoff summary` +
        (settings.autoClear ? ', then starting a fresh session that picks up where this one left off.' : '. Run /clear afterwards to load it into a fresh session.'),
    )
    const seen = await getRequests($)
    const left = cacheLeft(seen.rows, seen.ttlMinutes, await $.clock.now(), (await getKeepwarm($)).lastPing?.at)
    const last = lastMain(seen.rows)
    if (left !== undefined && left <= 0 && last !== undefined) {
      const cost = coldRewriteCost(promptTokens(last), last.model, seen.ttlMinutes)
      $.ui.toast(
        `Auto-handoff: the prompt cache is cold, so the summary re-bills about ${kilo(promptTokens(last))} tokens` +
          `${cost === undefined ? '' : ` (about ${usd(cost)})`}.`,
      )
    }
    const sessionId: string = await $.session.id()
    const root = slash(String(await $.session.root()))
    // A failure pauses the automatic handoff for this session, so it does not re-fork on every turn.
    const PAUSED = 'Automatic handoff is paused for this session; run /handoff-now to try again.'
    let text: string | undefined
    try {
      text = await summarize($)
    } catch (error) {
      await markHandedOff($, sessionId)
      await say($, `could not write a summary: ${String(error)}; nothing was cleared. ${PAUSED}`)
      return 'Could not write a summary; the session is untouched.'
    }
    if (text === undefined) {
      await markHandedOff($, sessionId)
      await say($, `could not write a summary, so nothing was cleared. ${PAUSED}`)
      return 'Could not write a summary; the session is untouched.'
    }

    const now: number = await $.clock.now()
    // The writing-handoffs skill's frontmatter, so its resume mode can read the file. A JSON
    // string is a valid YAML scalar, so a path with ' #' or ': ' still parses.
    const header =
      `---\n` +
      `date: ${new Date(now).toISOString()}\n` +
      `author: auto-handoff (session ${sessionId})\n` +
      `type: session\n` +
      `status: in-progress\n` +
      `project: ${JSON.stringify(root)}\n` +
      `reason: ${JSON.stringify(why)}\n` +
      `---\n\n`
    const content = header + text.trim() + '\n'
    // A project gets its own timestamped file, as the writing-handoffs skill does; a scratch
    // workspace is deleted with the session, so it uses the home-folder slots instead.
    const projectPath = isScratch(root) ? undefined : `${root}/${HANDOFFS_DIR}/${handoffFileName(now, sessionId)}`
    // A repo that cannot be written (read-only, permissions) falls back to the home-folder slots.
    const savedInProject =
      projectPath !== undefined && (await $.fs.write(projectPath, content).then(() => true, () => false))
    const path = savedInProject ? projectPath : await keepCopy($, content).catch(() => undefined)
    if (path === undefined) {
      await markHandedOff($, sessionId)
      await say($, `could not save the handoff anywhere, so nothing was cleared. ${PAUSED}`)
      return 'Could not save the handoff; the session is untouched.'
    }
    await $.store.set(pendingKey(root), { path, sessionId, root, savedAt: now } satisfies Pending)
    // In the store, so a hot reload or a /auto-handoff bar change does not trigger a second handoff.
    await markHandedOff($, sessionId)

    if (!settings.autoClear) {
      await say($, `handoff saved to ${path}. Run /clear and it loads into the new session.`)
      return `Handoff saved to ${path}. Run /clear to start fresh with it.`
    }

    await say($, `handoff saved to ${path}. Starting a fresh session…`)
    // Checked last, right before the /clear, which would wipe a prompt the user sent during the handoff.
    if (promptCount !== promptsBefore) {
      await say($, `handoff saved to ${path}, but you sent a new prompt meanwhile, so the session was not cleared. Run /clear yourself when ready.`)
      return `Handoff saved to ${path}; the session was not cleared. Run /clear yourself.`
    }
    // The /clear would cut off agents still working; their results belong to this session.
    const busy = await activeAgents($)
    if (busy.length > 0) {
      await say($, `handoff saved to ${path}, but ${agentsPhrase(busy.length)} still running, so the session was not cleared. Run /clear yourself once they finish.`)
      return `Handoff saved to ${path}; the session was not cleared while ${agentsPhrase(busy.length)} running. Run /clear yourself.`
    }
    // The old session is going away, and so is its cache; a ping now would only warm what is thrown out.
    await stopKeepwarm($, 'a handoff is clearing this session').catch(() => undefined)
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
  if ((await handedOffIds($)).includes(sessionId)) return
  const { context } = await $.session.usage()
  if ((context.percent ?? 0) < settings.threshold) return
  // Each background agent's result arrives as a new turn, so the next turn end checks again.
  const busy = await activeAgents($)
  if (busy.length > 0) {
    if (waitingFor !== sessionId) {
      waitingFor = sessionId
      await say($, `context at ${Math.round(context.percent)}%, but ${agentsPhrase(busy.length)} still running. The handoff waits until they finish.`)
    }
    return
  }
  await handoff($, `context at ${Math.round(context.percent)}%`)
}

// Whether the main thread is past the threshold with a handoff still to come.
const isPastThreshold = async ($: any, percent: number | undefined): Promise<boolean> => {
  const settings = await loadSettings($)
  if (!settings.enabled || (percent ?? 0) < settings.threshold) return false
  return !(await handedOffIds($)).includes(await $.session.id())
}

const WRAP_UP =
  'auto-handoff: the context is past the handoff threshold. The handoff runs only once this turn ends, ' +
  'and the session may be compacted first if the turn keeps going. Finish the step in hand, ' +
  'do not start new long work or new background agents, and end the turn soon.'

const describe = (s: Settings) =>
  `auto-handoff is ${s.enabled ? 'on' : 'off'} · threshold ${s.threshold}% · ` +
  `clear automatically: ${s.autoClear ? 'yes' : 'no'} · resume automatically: ${s.autoResume ? 'yes' : 'no'} · ` +
  `bar: ${s.showBar ? 'shown' : 'hidden'} · cache ttl: ${s.cacheTtlMinutes}m`

const USAGE =
  'Usage: /auto-handoff [on|off|status|<percent>|clear on|off|resume on|off|bar on|off|ttl <minutes>|tokens]'

const KEEPWARM_WARNING = 'Pings spend tokens: each one re-reads the whole cached context and gets a one-word answer.'
const KEEPWARM_USAGE =
  'Usage: /keepwarm <window> [every <period>] | status | off. A window is 90m, 2h or 2h30m (up to 24h). ' +
  `The period is a shorter gap than the default between pings, at least ${span(MIN_EVERY_MS)}. ${KEEPWARM_WARNING}`

// The reply to /keepwarm <window>: when pings go, and what they and a cold rewrite would cost.
const keepwarmArmed = async ($: any, windowMs: number): Promise<string> => {
  const c = await readCache($)
  const last = lastMain((await getRequests($)).rows)
  const tokens = last === undefined ? undefined : promptTokens(last)
  const pings = Math.min(MAX_PINGS, Math.max(1, Math.floor(windowMs / c.every)))
  const perPing = tokens === undefined ? undefined : warmReadCost(tokens, c.model)
  const cold = tokens === undefined ? undefined : coldRewriteCost(tokens, c.model, c.ttlMinutes)
  const when =
    c.left === undefined
      ? 'The first ping waits for the first request.'
      : c.left <= 0
        ? 'The cache is cold now, so no ping goes out until your next request warms it.'
        : `The next ping is in ${span(Math.max(0, c.left - c.ttlMinutes * 60000 + c.every))}.`
  const cost =
    perPing === undefined
      ? ''
      : ` Each re-reads about ${kilo(tokens!)} tokens, about ${usd(perPing)} before its answer; up to ${pings} in this window is about ${usd(perPing * pings)}.` +
        (cold === undefined ? '' : ` A cold rewrite of the same context would cost about ${usd(cold)}.`)
  return (
    `keepwarm on for ${span(windowMs)}: a ping each time the cache has sat idle for ${span(c.every)}, at most ${pings}. ${when} ${KEEPWARM_WARNING}${cost} ` +
    `/keepwarm off stops it; a handoff that clears the session does too.`
  )
}

// Green while well under the mark, yellow as it nears, red once past it.
const fillColor = (percent: number, threshold: number): 'red' | 'yellow' | 'green' =>
  percent >= threshold ? 'red' : percent >= threshold * 0.8 ? 'yellow' : 'green'

// One toast, the first time the mod runs for this user, so the auto-clear is not a surprise.
const introduce = async ($: any): Promise<void> => {
  if ((await $.store.get('introduced')) === true) return
  const settings = await loadSettings($)
  $.ui.toast(
    `auto-handoff is on: at ${settings.threshold}% context it writes a handoff and clears the session. ` +
      `/auto-handoff clear off keeps the session; /auto-handoff off disables it.`,
  )
  await $.store.set('introduced', true)
}

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
    await $.command.register({
      name: 'keepwarm',
      description: 'Keep the prompt cache warm with pings while you are away: /keepwarm 90m, status, off. Pings spend tokens',
      argumentHint: '<90m | 2h30m | status | off>',
      immediate: true,
    })
    quietly($, restoreKeepwarm($), 'keepwarm')
    quietly($, loadSettings($).then(settings => saveSettingsView($, settings)).then(() => refreshBar($)))
    quietly($, introduce($))
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
    if (result.usage !== null && e.agentId === undefined) isTranscriptNew = false
    return result
  })

  // Each tool call follows a model response, so the bar fills while a long turn runs.
  // Past the threshold mid-turn, the result tells the model to end the turn so the handoff can run.
  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    quietly($, refreshBar($))
    const result = await next(e)
    if (isNudged || result.deny !== undefined || result.isError === true) return result
    const isPast = await $.session
      .usage()
      .then(({ context }: any) => isPastThreshold($, context.percent))
      .catch(() => false)
    if (!isPast) return result
    isNudged = true
    return { ...result, context: [...(result.context ?? []), WRAP_UP] }
  }).catch(($, e, next) => next(e))

  // An automatic compaction got there before the handoff: keep the running agents in what survives it.
  on('session.compact', { trigger: 'auto' }, async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const busy = await activeAgents($)
    if (busy.length === 0) return next(e)
    const keep =
      'Background agents are still running and will report back to this session. ' +
      'Keep each one in the summary, with its id and name, what it was asked to do and that its result is still awaited:\n' +
      busy.map(agentLine).join('\n')
    void say($, `the session is being compacted before the handoff ran; the summary keeps the ${busy.length} running background agent(s).`)
    return next({ ...e, instructions: e.instructions === undefined ? keep : `${e.instructions}\n\n${keep}` })
  }).catch(($, e, next) => next(e))

  // Any compaction replaces the transcript, and the cache holds none of it: pings wait for the next request.
  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) {
      isTranscriptNew = true
      quietly($, armKeepwarm($), 'keepwarm')
    }
    return result
  }).catch(($, e, next) => next(e))

  // A /clear starts a new conversation: the old window and the old cache belong to the one thrown out.
  on('classic.SessionStart', async ($, e, next) => {
    const result = await next(e)
    if (e.source === 'clear') {
      isTranscriptNew = true
      quietly($, stopKeepwarm($, 'the session was cleared', false), 'keepwarm')
    }
    return result
  }).catch(($, e, next) => next(e))

  // A send into a cold cache pays to rewrite it; say how much before it goes. The prompt is never held back.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin?.kind === 'plugin' || typeof e.text !== 'string' || e.text.trimStart().startsWith('/')) return next(e)
    const note = await coldSendNote($).catch(() => undefined)
    if (note !== undefined) $.ui.log(`auto-handoff: ${note}`)
    return next(e)
  }).catch(($, e, next) => next(e))

  // The turn has ended: the session is idle enough for a fork and a queued /clear.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    // Any ended turn used the cache, so the next ping counts from here; a stale timer re-checks itself.
    quietly($, armKeepwarm($), 'keepwarm')
    if (e.reason !== 'answer') return result
    isNudged = false
    quietly($, refreshBar($))
    void checkContext($).catch((error: unknown) => {
      void say($, `failed: ${String(error)}`)
    })
    return result
  })

  // The first prompt of a conversation carries the handoff the previous session left.
  on('prompt.context', async ($, e, next) => {
    promptCount += 1
    const result = await next(e)
    const key = pendingKey(slash(String(await $.session.root())))
    const pending = (await $.store.get(key)) as Pending | undefined
    if (pending === undefined) return result
    const now: number = await $.clock.now()
    const isStale = now - pending.savedAt > MAX_PENDING_AGE_MS
    if (isStale) {
      await $.store.delete(key)
      return result
    }
    if (pending.sessionId === (await $.session.id())) return result

    const text = await $.fs.read(pending.path).catch(() => undefined)
    await $.store.delete(key)
    if (typeof text !== 'string') return result
    $.ui.toast('Loaded the handoff from your previous session.')
    return {
      ...result,
      blocks: [
        ...result.blocks,
        {
          name: 'handoff',
          text:
            'Handoff from the previous session, which ended at its context threshold. ' +
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

  on('command.run', { command: 'keepwarm' }, async ($, e) => {
    const words = e.args.trim().toLowerCase().split(/\s+/).filter(Boolean)
    const [first, second, third] = words

    if (first === undefined || first === 'status') {
      const line = keepwarmLine(await readCache($))
      return { text: line ?? `keepwarm is off. /keepwarm 90m keeps the cache warm for 90 minutes. ${KEEPWARM_WARNING}` }
    }
    if (first === 'off' || first === 'stop' || first === 'cancel') {
      const wasOn = (await getKeepwarm($)).until !== null
      await stopKeepwarm($, null)
      return { text: wasOn ? 'keepwarm is off; no more pings.' : 'keepwarm is off.' }
    }

    const windowMs = parseDuration(first)
    if (windowMs === undefined || words.length === 2 || words.length > 3 || (second !== undefined && second !== 'every')) {
      return { text: KEEPWARM_USAGE }
    }
    if (windowMs > MAX_WINDOW_MS) return { text: `A keepwarm window is at most ${span(MAX_WINDOW_MS)}. ${KEEPWARM_WARNING}` }
    let customEveryMs: number | null = null
    if (second === 'every') {
      const period = parseDuration(third ?? '')
      const ttl = (await loadSettings($)).cacheTtlMinutes
      if (period === undefined || period < MIN_EVERY_MS || period > defaultEveryMs(ttl)) {
        return { text: `every takes a period from ${span(MIN_EVERY_MS)} to ${span(defaultEveryMs(ttl))} (the default for a ${ttl}m cache).` }
      }
      customEveryMs = period
    }
    await startKeepwarm($, windowMs, customEveryMs)
    return { text: await keepwarmArmed($, windowMs) }
  })

  on('command.run', { command: 'auto-handoff' }, async ($, e) => {
    const settings = await loadSettings($)
    const before = { ...settings }
    const words = e.args.trim().toLowerCase().split(/\s+/).filter(Boolean)
    const [first, second] = words

    if (first === 'tokens') return { text: tokenReport(await getRequests($), await $.clock.now(), await getKeepwarm($)) }
    if (first === 'status' || first === undefined) {
      const last = (await $.store.get('lastHandoff')) as { at: number; text: string } | undefined
      const when = last === undefined ? '' : ` · last handoff ${clock(last.at)}: ${last.text}`
      const warm = keepwarmLine(await readCache($))
      return { text: describe(settings) + when + (warm === undefined ? '' : ` · ${warm}`) }
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
    // The ping period follows the cache lifetime.
    if (before.cacheTtlMinutes !== settings.cacheTtlMinutes) quietly($, armKeepwarm($), 'keepwarm')
    // A new threshold or turning it back on is a fresh decision; the bar, clear, resume and ttl are not.
    if (before.enabled !== settings.enabled || before.threshold !== settings.threshold) {
      await $.store.delete('handedOff')
    }
    return { text: describe(settings) }
  })

  // The bar: cells filled for the context used, a mark at the handoff threshold.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const state = await read($, bar)
    if (e.props.hasSurvey || !state.isShown) return next(e)

    const table = $.ui.resolve(e)
    const { Box, Text } = table
    const usage = await read($, requests)
    const kw = await read($, keepwarm)
    const now: number = await $.clock.now()
    const left = cacheLeft(usage.rows, usage.ttlMinutes, now, kw.lastPing?.at)
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
    // A third row only while keepwarm is on, or after it stopped by itself and has something to say.
    const keepText = keepwarmLine({
      kw,
      now,
      ttlMinutes: usage.ttlMinutes,
      model: last?.model,
      left: isTranscriptNew ? undefined : left,
      every: effectiveEveryMs(kw.customEveryMs ?? undefined, usage.ttlMinutes),
    })
    const keepLine =
      keepText === undefined ? null : (
        <Text color={kw.stopped === null ? undefined : 'yellow'} dimColor={kw.stopped === null}>
          {keepText}
        </Text>
      )
    const layout = (barRow: any) => (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          {barRow}
          {cacheLine}
        </Box>
        {requestLine}
        {keepLine}
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
