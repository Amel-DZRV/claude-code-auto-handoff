import { expect, mock, test } from 'claude-code/testing'

import {
  MAX_PINGS,
  PING_PROMPT,
  coldRewriteCost,
  defaultEveryMs,
  effectiveEveryMs,
  isWarmPing,
  parseDuration,
  pingCost,
  priceOf,
  usd,
} from '../hooks/keepwarm'

const MIN = 60_000
const HOUR = 60 * MIN
const START = 10 * HOUR

// A turn's request: 200,502 tokens of prompt on Sonnet 5, so a ping reads $0.04 and a cold rewrite is $0.80.
const request = { model: 'claude-sonnet-5', input_tokens: 2, output_tokens: 10, cache_read_input_tokens: 200_000, cache_creation_input_tokens: 500 }
const summaryUsage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

type ForkAnswer = { read: number; write: number; out?: number; input?: number } | { isAnswered: false; reason: string; [key: string]: unknown } | 'null' | 'throw'
const warm: ForkAnswer = { read: 200_000, write: 0 }

// The world beneath the mod: a store you can read, a clock you move, and a fork that answers
// pings from a script (warm when the script runs out) and summaries with a fixed handoff.
const world = (
  on: any,
  opts: {
    pings?: ForkAnswer[]
    store?: Map<string, unknown>
    sessionId?: () => string
    percent?: () => number
    request?: Record<string, unknown>
    summary?: () => unknown
    agents?: () => unknown[]
  } = {},
) => {
  const store = opts.store ?? new Map<string, unknown>()
  const clock = mock.clock(on, { now: START })
  const log = { pings: [] as string[], toasts: [] as string[], logs: [] as string[], appended: [] as unknown[], ran: [] as string[], submitted: [] as unknown[], written: [] as string[] }
  const pings = opts.pings ?? []
  const current = { request: opts.request ?? request }

  on('store.get', ($: any, e: any) => ({ value: store.get(e.key) }))
  on('store.set', ($: any, e: any) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', ($: any, e: any) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('session.id', () => ({ value: opts.sessionId?.() ?? 'S1' }))
  on('session.root', () => ({ value: '/proj' }))
  on('session.start', ($: any, e: any) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { context: { window: 200000, percent: opts.percent?.() ?? 10 } } }))
  on('command.register', () => ({ value: undefined }))
  on('ui.toast', ($: any, e: any) => {
    log.toasts.push(JSON.stringify(e))
    return { value: undefined }
  })
  on('ui.log', ($: any, e: any) => {
    log.logs.push(String(e.text))
    return { value: undefined }
  })
  on('session.append', ($: any, e: any) => {
    log.appended.push(e)
    return { value: undefined }
  })
  on('prompt.submit', ($: any, e: any) => {
    log.submitted.push(e)
    return { text: e.text }
  })
  on('prompt.context', () => ({ blocks: [] }))
  on('session.compact', ($: any, e: any) => ({ messages: e.messages }))
  on('classic.SessionStart', () => ({}))
  on('env.get', () => ({ value: '/Users/me' }))
  on('fs.list', () => ({ value: [] }))
  on('fs.write', ($: any, e: any) => {
    log.written.push(String(e.path))
    return { value: undefined }
  })
  on('agent.list', () => ({ value: opts.agents?.() ?? [] }))
  on('command.run', ($: any, e: any) => {
    log.ran.push(e.command)
    return { text: '' }
  })
  on('turn.step', async function* () {
    return { turnId: 't', index: 0, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: current.request }
  })
  on('turn.complete', () => ({ text: 'done' }))
  on('model.fork', async ($: any, e: any) => {
    if (e.prompt !== PING_PROMPT) {
      return opts.summary?.() ?? { value: { isAnswered: true, text: '## Summary\nShip it', usage: summaryUsage } }
    }
    log.pings.push(e.prompt)
    const answer = pings.shift() ?? warm
    if (answer === 'throw') throw new Error('model not permitted')
    if (answer === 'null') return { value: null }
    if ('isAnswered' in answer) return { value: answer }
    return {
      value: {
        isAnswered: true,
        text: 'warm',
        usage: {
          input_tokens: answer.input ?? 2,
          output_tokens: answer.out ?? 1,
          cache_read_input_tokens: answer.read,
          cache_creation_input_tokens: answer.write,
        },
      },
    }
  })
  return { store, clock, log, current }
}

const startSession = ($: any) => $.session.start({ source: 'startup', cwd: '/proj' })

// A model request and the end of its turn, which is when the mod re-arms the next ping.
const finishTurn = async ($: any, clock: any, reason = 'answer') => {
  for await (const _chunk of $.turn.step({ turnId: 't', index: 0, model: 'm', messageCount: 1 })) void _chunk
  await $.turn.complete({ turnId: 't', reason, answer: 'done', durationMs: 1000, isAborted: false })
  await clock.settle()
}

const keepwarm = (args: string) => ({ command: 'keepwarm', args, origin: { kind: 'composer' } })
const autoHandoff = (args: string) => ({ command: 'auto-handoff', args, origin: { kind: 'composer' } })
const send = (text: string, origin: { kind: string } = { kind: 'composer' }) => ({ text, wait: false, origin })
const windows = (store: Map<string, unknown>) => [...store.keys()].filter(key => key.startsWith('keepwarm:'))
const cents = (amount: number | undefined) => Math.round((amount ?? NaN) * 1e6) / 1e6
const toastsInclude = (toasts: string[], text: string) => toasts.some(t => t.includes(text))

test('/keepwarm says that pings cost tokens and what they and a cold rewrite would cost', async ($, on) => {
  const { clock } = world(on)
  await startSession($)
  const before = await $.command.run(keepwarm('90m'))
  expect(before.text).toContain('keepwarm on for 1h30m')
  expect(before.text).toContain('Pings spend tokens')
  expect(before.text).toContain('first ping waits for the first request')

  await finishTurn($, clock)
  const after = await $.command.run(keepwarm('90m'))
  expect(after.text).toContain('Pings spend tokens')
  expect(after.text).toContain('next ping is in 50m')
  // 200,502 tokens: a read at $0.20 per million, a 1h rewrite at $4 per million.
  expect(after.text).toContain('about 201k tokens, about $0.04')
  expect(after.text).toContain('A cold rewrite of the same context would cost about $0.80')
})

test('a ping goes out 50 minutes after the last request, again 50 minutes later, and reports what it read', async ($, on) => {
  const { clock, log } = world(on)
  await startSession($)
  await $.command.run(keepwarm('3h'))
  await finishTurn($, clock)

  await clock.advance(49 * MIN)
  expect(log.pings).toHaveLength(0)
  await clock.advance(1 * MIN)
  expect(log.pings).toEqual([PING_PROMPT])
  const status = await $.command.run(keepwarm('status'))
  expect(status.text).toContain('next ping in 50m')
  expect(status.text).toContain('1 ping, about $0.04')
  expect(status.text).toContain('last ping read 200k')

  await clock.advance(50 * MIN)
  expect(log.pings).toHaveLength(2)
})

test('a new request pushes the next ping back', async ($, on) => {
  const { clock, log } = world(on)
  await startSession($)
  await $.command.run(keepwarm('3h'))
  await finishTurn($, clock)
  await clock.advance(40 * MIN)
  await finishTurn($, clock)
  await clock.advance(40 * MIN)
  expect(log.pings).toHaveLength(0)
  await clock.advance(10 * MIN)
  expect(log.pings).toHaveLength(1)
})

test('requests inside a long turn keep the cache warm, so the pending ping holds off', async ($, on) => {
  const { clock, log } = world(on)
  await startSession($)
  await $.command.run(keepwarm('6h'))
  await finishTurn($, clock)
  await clock.advance(40 * MIN)
  // A model request with no turn end yet: a long turn still working.
  for await (const _chunk of $.turn.step({ turnId: 't', index: 0, model: 'm', messageCount: 3 })) void _chunk

  await clock.advance(15 * MIN)
  expect(log.pings).toHaveLength(0)
  await clock.advance(40 * MIN)
  expect(log.pings).toHaveLength(1)
})

test('the window ends on its own, quietly, and no ping follows', async ($, on) => {
  const { clock, log, store } = world(on)
  await startSession($)
  await $.command.run(keepwarm('2h'))
  expect(store.get('keepwarm:S1')).toBeDefined()
  await finishTurn($, clock)

  await clock.advance(2 * HOUR)
  expect(log.pings).toHaveLength(2)
  expect(store.has('keepwarm:S1')).toBe(false)
  expect((await $.command.run(keepwarm('status'))).text).toContain('keepwarm is off')

  await clock.advance(3 * HOUR)
  expect(log.pings).toHaveLength(2)
  expect(log.toasts.filter(t => t.includes('keepwarm stopped'))).toEqual([])
})

test('/keepwarm off cancels the pings and forgets the window', async ($, on) => {
  const { clock, log, store } = world(on)
  await startSession($)
  await $.command.run(keepwarm('3h'))
  await finishTurn($, clock)
  await clock.advance(30 * MIN)

  const off = await $.command.run(keepwarm('off'))
  expect(off.text).toBe('keepwarm is off; no more pings.')
  expect(store.has('keepwarm:S1')).toBe(false)
  await clock.advance(3 * HOUR)
  expect(log.pings).toHaveLength(0)
  expect((await $.command.run(keepwarm('off'))).text).toBe('keepwarm is off.')
})

test('a bare /keepwarm only reports; it never arms pings', async ($, on) => {
  const { clock, log, store } = world(on)
  await startSession($)
  await finishTurn($, clock)
  const answer = await $.command.run(keepwarm(''))
  expect(answer.text).toContain('keepwarm is off')
  expect(answer.text).toContain('Pings spend tokens')
  await clock.advance(3 * HOUR)
  expect(log.pings).toHaveLength(0)
  expect(windows(store)).toEqual([])
})

test('unusable arguments are refused with the usage line and the cost warning', async ($, on) => {
  const { store } = world(on)
  await startSession($)
  for (const args of ['soon', '90', '90m every', '90m often 5m', '90m every 30s', '90m every 2h', '90m every 5m extra']) {
    const answer = await $.command.run(keepwarm(args))
    expect(answer.text).toMatch(/Usage|every takes/)
  }
  const tooLong = await $.command.run(keepwarm('25h'))
  expect(tooLong.text).toContain('at most 24h00m')
  expect(tooLong.text).toContain('Pings spend tokens')
  expect(windows(store)).toEqual([])
})

test('a window already cold sends no ping until the next request warms the cache', async ($, on) => {
  const { clock, log } = world(on)
  await startSession($)
  await finishTurn($, clock)
  await clock.advance(2 * HOUR)

  const armed = await $.command.run(keepwarm('3h'))
  expect(armed.text).toContain('cache is cold now')
  await clock.advance(HOUR)
  expect(log.pings).toHaveLength(0)
  expect((await $.command.run(keepwarm('status'))).text).toContain('the cache is cold, so no ping until the next request')

  await finishTurn($, clock)
  await clock.advance(50 * MIN)
  expect(log.pings).toHaveLength(1)
})

test('a ping that read nothing stops the window and says what it cost', async ($, on) => {
  const { clock, log, store } = world(on, { pings: [{ read: 0, write: 180_000 }] })
  await startSession($)
  await $.command.run(keepwarm('6h'))
  await finishTurn($, clock)
  await clock.advance(50 * MIN)

  expect(log.pings).toHaveLength(1)
  expect(toastsInclude(log.toasts, 'keepwarm stopped: a ping read 0 and wrote 180k tokens ($0.72), so the cache was already gone')).toBe(true)
  expect(store.has('keepwarm:S1')).toBe(false)
  expect((await $.command.run(keepwarm('status'))).text).toContain('Keepwarm stopped')
  await clock.advance(3 * HOUR)
  expect(log.pings).toHaveLength(1)
})

for (const [name, answer, reason] of [
  ['an API error', { isAnswered: false, reason: 'api-error', status: 429, error: 'rate_limit', usage: summaryUsage }, 'the API call failed (429)'],
  ['an interrupted ping', { isAnswered: false, reason: 'aborted', usage: summaryUsage }, 'the ping was interrupted'],
  ['nothing to fork', { isAnswered: false, reason: 'nothing-to-fork' }, 'there is no conversation to warm yet'],
  ['an empty reply', { isAnswered: false, reason: 'empty-reply', usage: summaryUsage }, 'the ping got no text back'],
  ['a refused call', 'throw', 'the ping failed ('],
  ['an older engine answering null', 'null', 'the engine did not send the ping'],
] as [string, ForkAnswer, string][]) {
  test(`${name} stops keepwarm without retrying`, async ($, on) => {
    const { clock, log } = world(on, { pings: [answer] })
    await startSession($)
    await $.command.run(keepwarm('6h'))
    await finishTurn($, clock)
    await clock.advance(50 * MIN)
    expect(toastsInclude(log.toasts, `keepwarm stopped: ${reason}`)).toBe(true)
    await clock.advance(3 * HOUR)
    expect(log.pings).toHaveLength(1)
  })
}

test('a window sends at most MAX_PINGS pings, whatever its length', async ($, on) => {
  const { clock, log } = world(on)
  await startSession($)
  await $.command.run(keepwarm('24h every 1m'))
  await finishTurn($, clock)
  await clock.advance((MAX_PINGS + 5) * MIN)
  expect(log.pings).toHaveLength(MAX_PINGS)
  expect(toastsInclude(log.toasts, `${MAX_PINGS}-ping limit`)).toBe(true)
})

test('every shortens the period for one window only', async ($, on) => {
  const { clock, log } = world(on)
  await startSession($)
  await $.command.run(keepwarm('1h every 2m'))
  await finishTurn($, clock)
  await clock.advance(2 * MIN)
  expect(log.pings).toHaveLength(1)
  await $.command.run(keepwarm('off'))

  await $.command.run(keepwarm('3h'))
  await finishTurn($, clock)
  await clock.advance(10 * MIN)
  expect(log.pings).toHaveLength(1)
})

test('the ping period follows the cache lifetime, and a changed ttl re-arms the pending ping', async ($, on) => {
  const { clock, log } = world(on)
  await startSession($)
  await $.command.run(keepwarm('3h'))
  await finishTurn($, clock)
  await $.command.run(autoHandoff('ttl 5'))
  await clock.settle()

  await clock.advance(3 * MIN)
  expect(log.pings).toHaveLength(0)
  await clock.advance(1 * MIN)
  expect(log.pings).toHaveLength(1)
})

test('a window outlives a reload; an expired one is cleaned up at session start', async ($, on) => {
  const store = new Map<string, unknown>([['keepwarm:S1', { until: START + 3 * HOUR, customEveryMs: null }]])
  const { clock, log } = world(on, { store })
  await startSession($)
  await clock.settle()
  expect((await $.command.run(keepwarm('status'))).text).toContain('waiting for the first request')
  await finishTurn($, clock)
  await clock.advance(50 * MIN)
  expect(log.pings).toHaveLength(1)
})

test('an expired stored window is deleted when the session starts', async ($, on) => {
  const store = new Map<string, unknown>([['keepwarm:S1', { until: START - MIN, customEveryMs: null }]])
  const { clock } = world(on, { store })
  await startSession($)
  await clock.settle()
  expect(store.has('keepwarm:S1')).toBe(false)
  expect((await $.command.run(keepwarm('status'))).text).toContain('keepwarm is off')
})

test('stopping one session leaves another session\'s window alone', async ($, on) => {
  const store = new Map<string, unknown>([['keepwarm:S2', { until: START + 3 * HOUR, customEveryMs: null }]])
  world(on, { store })
  await startSession($)
  await $.command.run(keepwarm('2h'))
  await $.command.run(keepwarm('off'))
  expect(store.has('keepwarm:S1')).toBe(false)
  expect(store.has('keepwarm:S2')).toBe(true)
})

test('a model with no known price still pings, and prints no dollars it cannot know', async ($, on) => {
  const { clock, log } = world(on, { request: { ...request, model: 'some-new-model' } })
  await startSession($)
  await finishTurn($, clock)
  const armed = await $.command.run(keepwarm('3h'))
  expect(armed.text).toContain('Pings spend tokens')
  expect(armed.text).not.toContain('$')
  await clock.advance(50 * MIN)
  expect(log.pings).toHaveLength(1)
  expect((await $.command.run(keepwarm('status'))).text).toContain('last ping read 200k (n/a)')
})

test('a compaction waits for the next request before pings resume', async ($, on) => {
  const { clock, log } = world(on)
  await startSession($)
  await $.command.run(keepwarm('6h'))
  await finishTurn($, clock)
  await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'summary', toolUses: [] }] })
  await clock.settle()

  await clock.advance(2 * HOUR)
  expect(log.pings).toHaveLength(0)
  expect((await $.command.run(keepwarm('status'))).text).toContain('waiting for the first request after the compaction')

  await finishTurn($, clock)
  await clock.advance(50 * MIN)
  expect(log.pings).toHaveLength(1)
})

test('a subagent\'s compaction and requests do not move the ping clock', async ($, on) => {
  const { clock, log } = world(on)
  await startSession($)
  await $.command.run(keepwarm('6h'))
  await finishTurn($, clock)
  await clock.advance(30 * MIN)
  await $.session.compact({ trigger: 'manual', agentId: 'worker', messages: [{ role: 'user', text: 'x', toolUses: [] }] })
  await $.turn.complete({ turnId: 'w', agentId: 'worker', reason: 'answer', answer: 'x', durationMs: 1, isAborted: false })
  await clock.advance(20 * MIN)
  expect(log.pings).toHaveLength(1)
})

test('a /clear ends the window with a notice and no further ping', async ($, on) => {
  const { clock, log, store } = world(on)
  await startSession($)
  await $.command.run(keepwarm('6h'))
  await finishTurn($, clock)
  await $.classic.SessionStart({ source: 'clear' })
  await clock.settle()

  expect(toastsInclude(log.toasts, 'keepwarm stopped: the session was cleared')).toBe(true)
  expect(store.has('keepwarm:S1')).toBe(false)
  expect((await $.command.run(keepwarm('status'))).text).toContain('keepwarm is off')
  await clock.advance(3 * HOUR)
  expect(log.pings).toHaveLength(0)
})

test('/auto-handoff tokens counts pings apart from the conversation\'s requests', async ($, on) => {
  const { clock } = world(on)
  await startSession($)
  await $.command.run(keepwarm('3h'))
  await finishTurn($, clock)
  await clock.advance(50 * MIN)

  const report = (await $.command.run(autoHandoff('tokens'))).text
  expect(report).toContain('Main thread: 1 requests')
  expect(report).toContain('Keepwarm: 1 ping this window, about $0.04')
  expect(report).toContain('Cache: warm, 1h00m left of 60m')
})

// What a handoff does to a window, and what a ping must not do to a handoff.

test('a ping appends nothing, submits no prompt and cannot start a handoff, even past the threshold', async ($, on) => {
  const { clock, log, store } = world(on, { percent: () => 90 })
  await startSession($)
  await $.command.run(autoHandoff('off'))
  await $.command.run(keepwarm('3h'))
  await finishTurn($, clock)
  await clock.advance(50 * MIN)

  expect(log.pings).toHaveLength(1)
  expect(log.appended).toEqual([])
  expect(log.submitted).toEqual([])
  expect(log.ran).toEqual([])
  expect(log.written).toEqual([])
  expect(store.get('handedOff')).toBeUndefined()
  expect(store.get('lastHandoff')).toBeUndefined()
})

test('a handoff that clears the session ends the window first, so no ping warms the old cache', async ($, on) => {
  const { clock, log, store } = world(on, { percent: () => 90 })
  await startSession($)
  await $.command.run(keepwarm('6h'))
  await finishTurn($, clock)
  await clock.advance(1 * MIN)

  expect(log.ran).toEqual(['clear'])
  expect(toastsInclude(log.toasts, 'keepwarm stopped: a handoff is clearing this session')).toBe(true)
  expect(store.has('keepwarm:S1')).toBe(false)
  await clock.advance(4 * HOUR)
  expect(log.pings).toHaveLength(0)
})

test('a handoff that leaves the session running leaves the window running', async ($, on) => {
  const { clock, log, store } = world(on, { percent: () => 90 })
  await startSession($)
  await $.command.run(autoHandoff('clear off'))
  await $.command.run(keepwarm('6h'))
  await finishTurn($, clock)
  await clock.advance(1 * MIN)

  expect(log.written).toHaveLength(1)
  expect(log.ran).toEqual([])
  expect(store.has('keepwarm:S1')).toBe(true)
  await clock.advance(50 * MIN)
  expect(log.pings).toHaveLength(1)
})

test('a ping due while the summary is written waits, and the clear that follows cancels it', async ($, on) => {
  let release: () => void = () => undefined
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  const { clock, log } = world(on, {
    percent: () => 90,
    summary: async () => {
      await gate
      return { value: { isAnswered: true, text: '## Summary\nShip it', usage: summaryUsage } }
    },
  })
  await startSession($)
  await $.command.run(keepwarm('6h'))
  await finishTurn($, clock)

  await clock.advance(55 * MIN)
  expect(log.pings).toHaveLength(0)
  expect(log.written).toHaveLength(0)

  release()
  await clock.advance(1 * MIN)
  expect(log.ran).toEqual(['clear'])
  await clock.advance(3 * HOUR)
  expect(log.pings).toHaveLength(0)
})

test('a failed handoff puts a deferred ping back on the clock', async ($, on) => {
  let release: () => void = () => undefined
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  const { clock, log } = world(on, {
    percent: () => 90,
    summary: async () => {
      await gate
      return { value: { isAnswered: false, reason: 'empty-reply', usage: summaryUsage } }
    },
  })
  on('model.complete', () => ({ value: { isAnswered: false, reason: 'empty-reply', usage: summaryUsage } }))
  on('session.messages', () => ({ value: [{ role: 'user', text: 'hi' }] }))
  await startSession($)
  await $.command.run(keepwarm('6h'))
  await finishTurn($, clock)

  await clock.advance(55 * MIN)
  expect(log.pings).toHaveLength(0)
  release()
  await clock.advance(1 * MIN)
  expect(log.ran).toEqual([])
  await clock.advance(50 * MIN)
  expect(log.pings.length).toBeGreaterThan(0)
})

// The cold-send estimate.

test('a send into a cold cache shows what the rewrite costs, and still goes through', async ($, on) => {
  const { clock, log } = world(on)
  await startSession($)
  await finishTurn($, clock)
  await clock.advance(2 * HOUR)

  const sent = await $.prompt.submit(send('give me a recap'))
  expect(sent.drop).toBeUndefined()
  expect(sent.text).toBe('give me a recap')
  expect(log.logs).toHaveLength(1)
  expect(log.logs[0]).toContain('went cold 1h00m ago')
  expect(log.logs[0]).toContain('up to 200,502 tokens')
  expect(log.logs[0]).toContain('about $0.80')
  expect(log.logs[0]).toContain('a warm turn would have cost about $0.04')
  expect(log.logs[0]).toContain('/keepwarm <duration>')
})

test('no estimate for a warm cache, a slash command, a plugin prompt, a small context or a cache kept warm by pings', async ($, on) => {
  const { clock, log, current } = world(on)
  await startSession($)
  await finishTurn($, clock)
  await clock.advance(30 * MIN)
  await $.prompt.submit(send('warm one'))

  await clock.advance(2 * HOUR)
  await $.prompt.submit(send('/clear'))
  await $.prompt.submit(send('Continue from the handoff notes.', { kind: 'plugin' }))
  expect(log.logs).toEqual([])

  current.request = { ...request, cache_read_input_tokens: 20_000 }
  await finishTurn($, clock)
  await clock.advance(2 * HOUR)
  await $.prompt.submit(send('small one'))
  expect(log.logs).toEqual([])

  current.request = request
  await finishTurn($, clock)
  await $.command.run(keepwarm('3h'))
  await clock.advance(2 * HOUR + 30 * MIN)
  await $.prompt.submit(send('after the break'))
  expect(log.logs).toEqual([])
})

test('no estimate right after a /clear or a compaction, whose first request is small', async ($, on) => {
  const { clock, log } = world(on)
  await startSession($)
  await finishTurn($, clock)
  await clock.advance(2 * HOUR)
  await $.classic.SessionStart({ source: 'clear' })
  await $.prompt.submit(send('first prompt of the fresh session'))
  expect(log.logs).toEqual([])

  await finishTurn($, clock)
  await clock.advance(2 * HOUR)
  await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'summary', toolUses: [] }] })
  await $.prompt.submit(send('after the compaction'))
  expect(log.logs).toEqual([])
})

test('a cold /handoff-now toast prices the re-billed tokens', async ($, on) => {
  const { clock, log } = world(on)
  await startSession($)
  await finishTurn($, clock)
  await clock.advance(2 * HOUR)
  await $.command.run({ command: 'handoff-now', args: '', origin: { kind: 'composer' } })
  await clock.advance(1 * MIN)
  expect(toastsInclude(log.toasts, 'the summary re-bills about 201k tokens (about $0.80)')).toBe(true)
})

// The bar's keepwarm row.

const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 100, scroll: { bodyRows: 5, offset: 0, isAtTop: true, isAtBottom: true } },
} as const

test('the bar gets a keepwarm row while it is on, counts pings as cache use, and says why it stopped', async ($, on) => {
  const { clock } = world(on, { pings: [warm, { read: 0, write: 200_000 }] })
  await startSession($)
  await finishTurn($, clock)
  const ui = await $.ui.mount({ plugin: 'auto-handoff', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: /Keepwarm/ })).toBeUndefined()

  await $.command.run(keepwarm('3h'))
  expect(await ui.find({ type: 'Text', text: /Keepwarm 3h00m left · next ping in 50m/ })).toBeDefined()

  await clock.advance(50 * MIN)
  expect(await ui.find({ type: 'Text', text: /Keepwarm 2h10m left · next ping in 50m · 1 ping, about \$0\.04 · last ping read 200k/ })).toBeDefined()
  // The ping refreshed the cache, so the countdown starts over.
  expect(await ui.find({ type: 'Text', text: /Cache warm 1h00m left/ })).toBeDefined()

  await clock.advance(50 * MIN)
  expect(await ui.find({ type: 'Text', text: /Keepwarm stopped: a ping read 0 and wrote 200k tokens/ })).toBeDefined()
  await $.command.run(keepwarm('off'))
  expect(await ui.find({ type: 'Text', text: /Keepwarm/ })).toBeUndefined()
  await ui.unmount()
})

// The pure parts.

test('durations parse as hours and minutes and nothing else', () => {
  expect(parseDuration('90m')).toBe(90 * MIN)
  expect(parseDuration('2h')).toBe(2 * HOUR)
  expect(parseDuration('2h30m')).toBe(150 * MIN)
  expect(parseDuration(' 1H ')).toBe(HOUR)
  for (const bad of ['', '0m', 'soon', '90', '1.5h', '30s', '-5m', 'm', 'h30']) expect(parseDuration(bad)).toBeUndefined()
})

test('prices match the longest family name, and an unknown model has none', () => {
  expect(priceOf('claude-fable-5-1')).toEqual({ read: 0.25, write: 20, output: 50 })
  expect(priceOf('claude-fable-5')).toEqual({ read: 1, write: 20, output: 50 })
  expect(priceOf('Claude Sonnet 5')?.write).toBe(4)
  expect(priceOf('claude-sonnet-4-5')?.write).toBe(6)
  expect(priceOf('some-new-model')).toBeUndefined()
  expect(priceOf(undefined)).toBeUndefined()
})

test('a ping is billed for the read, any write, uncached input at half the write rate, and the answer', () => {
  const price = priceOf('claude-sonnet-5')
  expect(cents(pingCost({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 0 }, price))).toBe(0.2)
  expect(cents(pingCost({ input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 1_000_000 }, price))).toBe(4 + 2 + 10)
  expect(pingCost({ input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 1, cache_creation_input_tokens: 1 }, undefined)).toBeUndefined()
  expect(usd(0.0432)).toBe('$0.04')
  expect(usd(250)).toBe('$250')
  expect(usd(undefined)).toBe('n/a')
})

test('a ping is warm when it read the prefix and wrote under a tenth of it', () => {
  const ping = (read: number, write: number) => ({ input_tokens: 2, output_tokens: 1, cache_read_input_tokens: read, cache_creation_input_tokens: write })
  expect(isWarmPing(ping(200_000, 0))).toBe(true)
  expect(isWarmPing(ping(200_000, 19_999))).toBe(true)
  expect(isWarmPing(ping(200_000, 20_000))).toBe(false)
  expect(isWarmPing(ping(0, 200_000))).toBe(false)
})

test('the ping period leaves a margin inside the cache lifetime, and a custom one can only be shorter', () => {
  expect(defaultEveryMs(60)).toBe(50 * MIN)
  expect(defaultEveryMs(5)).toBe(4 * MIN)
  expect(defaultEveryMs(120)).toBe(110 * MIN)
  expect(effectiveEveryMs(undefined, 60)).toBe(50 * MIN)
  expect(effectiveEveryMs(2 * MIN, 60)).toBe(2 * MIN)
  expect(effectiveEveryMs(2 * MIN, 5)).toBe(2 * MIN)
  expect(effectiveEveryMs(30 * MIN, 5)).toBe(4 * MIN)
})

test('a five-minute cache is rewritten at the cheaper write rate', () => {
  expect(cents(coldRewriteCost(1_000_000, 'claude-sonnet-5', 60))).toBe(4)
  expect(cents(coldRewriteCost(1_000_000, 'claude-sonnet-5', 5))).toBe(2.5)
  expect(coldRewriteCost(1_000_000, 'unknown', 60)).toBeUndefined()
})
