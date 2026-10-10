import { expect, test } from 'claude-code/testing'

const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

const waitFor = async (isDone: () => boolean) => {
  for (let i = 0; i < 200 && !isDone(); i++) await new Promise(resolve => setTimeout(resolve, 5))
}

// The one pending handoff a test has saved, whatever project key it sits under.
const pendingOf = (store: Map<string, unknown>): any => [...store.entries()].find(([key]) => key.startsWith('pending:'))?.[1]

const stubHost = (
  on: any,
  store: Map<string, unknown>,
  written: Map<string, string>,
  ran: string[],
  sessionId = 'old-session',
  host: { root: string; listing: { name: string; mtimeMs: number }[] } = { root: '/proj', listing: [] },
  // Replaces a default stub by host call name; the harness refuses a second on() for the same call.
  overrides: Record<string, (...args: any[]) => unknown> = {},
) => {
  const stubbed = on
  on = (name: string, handler: unknown) => stubbed(name, overrides[name] ?? handler)
  on('env.get', () => ({ value: '/Users/me' }))
  on('fs.list', () => ({ value: host.listing }))
  on('store.get', ($: any, e: any) => ({ value: store.get(e.key) }))
  on('store.set', ($: any, e: any) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', ($: any, e: any) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('clock.now', () => ({ value: 1_000_000 }))
  on('session.id', () => ({ value: sessionId }))
  on('session.root', () => ({ value: host.root }))
  on('model.fork', () => ({ value: { isAnswered: true, text: '## Summary\nShip it', usage } }))
  on('fs.write', ($: any, e: any) => {
    written.set(e.path, e.text)
    return { value: undefined }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('agent.list', () => ({ value: [] }))
  on('command.run', ($: any, e: any) => {
    ran.push(e.command)
    return { text: '' }
  })
}

test('/handoff-now writes a timestamped file in the project, saves the pending marker and clears', async ($, on) => {
  const store = new Map<string, unknown>()
  const written = new Map<string, string>()
  const ran: string[] = []
  stubHost(on, store, written, ran)

  const answer = await $.command.run({ command: 'handoff-now', args: '' })
  await waitFor(() => ran.includes('clear'))

  expect(answer.text).toBe('Writing the handoff…')
  const paths = [...written.keys()].map(p => p.replace(/\\/g, '/'))
  expect(paths).toHaveLength(1)
  expect(paths[0]).toMatch(/^\/proj\/\.claude\/handoffs\/\d{4}-\d{2}-\d{2}-\d{6}-auto-handoff-old-sess\.md$/)
  expect(written.get([...written.keys()][0]!)).toContain('## Summary')
  expect(ran).toEqual(['clear'])
  expect((pendingOf(store) as { path: string }).path.replace(/\\/g, '/')).toBe(paths[0])
})

test('two sessions handing off in the same second get different files', async ($, on) => {
  const written = new Map<string, string>()
  const ran: string[] = []
  stubHost(on, new Map(), written, ran, 'session-aaaaaaaa')
  await $.command.run({ command: 'handoff-now', args: '' })
  await waitFor(() => ran.includes('clear'))
  const [first] = [...written.keys()]
  expect(first).toContain('session-')
  expect(first).not.toContain('aaaaaaaa') // only the first 8 chars of the id are used
})

test('with no project folder the handoff is saved to the home folder and loaded from there', async ($, on) => {
  const store = new Map<string, unknown>()
  const written = new Map<string, string>()
  const ran: string[] = []
  const host = { root: '/Users/me/Library/Claude/scratch-workspaces/a/b/scratch-1', listing: [] }
  stubHost(on, store, written, ran, 'old-session', host)

  await $.command.run({ command: 'handoff-now', args: '' })
  await waitFor(() => ran.includes('clear'))

  const paths = [...written.keys()].map(p => p.replace(/\\/g, '/'))
  expect(paths).toEqual(['/Users/me/.claude/handoffs/handoff-1.md'])
  expect((pendingOf(store) as { path: string }).path.replace(/\\/g, '/')).toBe(paths[0])
})

test('a full set of kept handoffs reuses the oldest slot', async ($, on) => {
  const written = new Map<string, string>()
  const ran: string[] = []
  const host = {
    root: '/Users/me/Library/Claude/scratch-workspaces/a/b/scratch-1',
    listing: [1, 2, 3, 4, 5].map(n => ({ name: `handoff-${n}.md`, mtimeMs: n === 3 ? 10 : 100 + n })),
  }
  stubHost(on, new Map(), written, ran, 'old-session', host)

  await $.command.run({ command: 'handoff-now', args: '' })
  await waitFor(() => ran.includes('clear'))

  expect([...written.keys()].map(p => p.replace(/\\/g, '/'))).toEqual(['/Users/me/.claude/handoffs/handoff-3.md'])
})

test('the next session loads the handoff once', async ($, on) => {
  const store = new Map<string, unknown>([
    ['pending:/proj', { path: '/proj/.claude/handoff.md', sessionId: 'old-session', root: '/proj', savedAt: 1_000_000 }],
  ])
  stubHost(on, store, new Map(), [], 'new-session')
  on('fs.read', () => ({ value: '## Summary\nShip it' }))
  on('prompt.context', () => ({ blocks: [{ name: 'currentDate', text: 'today' }] }))

  const first = await $.prompt.context({ blocks: [] })
  expect(first.blocks.map((b: { name: string }) => b.name)).toEqual(['currentDate', 'handoff'])
  expect((pendingOf(store) !== undefined)).toBe(false)

  const second = await $.prompt.context({ blocks: [] })
  expect(second.blocks.map((b: { name: string }) => b.name)).toEqual(['currentDate'])
})

test('/auto-handoff sets the threshold', async ($, on) => {
  stubHost(on, new Map(), new Map(), [])
  const answer = await $.command.run({ command: 'auto-handoff', args: '40' })
  expect(answer.text).toContain('threshold 40%')
})

test('the pending handoff is saved with the project root', async ($, on) => {
  const store = new Map<string, unknown>()
  const ran: string[] = []
  stubHost(on, store, new Map(), ran)

  await $.command.run({ command: 'handoff-now', args: '' })
  await waitFor(() => ran.includes('clear'))

  expect((pendingOf(store) as { root: string }).root).toBe('/proj')
})

test('a session in another project leaves the pending handoff alone', async ($, on) => {
  const store = new Map<string, unknown>([
    ['pending:/proj', { path: '/proj/.claude/handoffs/x.md', sessionId: 'old-session', root: '/proj', savedAt: 1_000_000 }],
  ])
  stubHost(on, store, new Map(), [], 'new-session', { root: '/other', listing: [] })
  on('fs.read', () => ({ value: '## Summary\nShip it' }))
  on('prompt.context', () => ({ blocks: [{ name: 'currentDate', text: 'today' }] }))

  const first = await $.prompt.context({ blocks: [] })
  expect(first.blocks.map((b: { name: string }) => b.name)).toEqual(['currentDate'])
  expect((pendingOf(store) !== undefined)).toBe(true)
})

test('a prompt submitted during the summary stops the /clear', async ($, on) => {
  const store = new Map<string, unknown>()
  const written = new Map<string, string>()
  const ran: string[] = []
  let release: () => void = () => undefined
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  stubHost(on, store, written, ran, 'old-session', undefined, {
    'model.fork': async () => {
      await gate
      return { value: { isAnswered: true, text: '## Summary\nShip it', usage } }
    },
  })
  on('prompt.context', () => ({ blocks: [] }))

  const answer = await $.command.run({ command: 'handoff-now', args: '' })
  expect(answer.text).toBe('Writing the handoff…')
  await $.prompt.context({ blocks: [] }) // the user typed something while the summary runs
  release()
  await waitFor(() => written.size === 1 && (pendingOf(store) !== undefined))
  await new Promise(resolve => setTimeout(resolve, 20))

  expect(ran).not.toContain('clear')
  expect((store.get('lastHandoff') as { text: string }).text).toContain('Run /clear yourself')
})

const stubTurnEnd = (on: any, percent: number) => {
  on('session.usage', () => ({ value: { context: { window: 200000, percent } } }))
  on('turn.complete', () => ({ text: 'done' }))
}

test('a session that already handed off does not hand off again, even after an unrelated setting change', async ($, on) => {
  const store = new Map<string, unknown>([['handedOff', ['old-session']]])
  const written = new Map<string, string>()
  const ran: string[] = []
  stubHost(on, store, written, ran)
  stubTurnEnd(on, 90)

  await $.turn.complete({ turnId: 't', reason: 'answer', answer: 'done' })
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(written.size).toBe(0)

  await $.command.run({ command: 'auto-handoff', args: 'bar off' })
  await $.turn.complete({ turnId: 't', reason: 'answer', answer: 'done' })
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(written.size).toBe(0)
})

test('changing the threshold allows a new handoff', async ($, on) => {
  const store = new Map<string, unknown>([['handedOff', ['old-session']]])
  const written = new Map<string, string>()
  const ran: string[] = []
  stubHost(on, store, written, ran)
  stubTurnEnd(on, 90)

  await $.command.run({ command: 'auto-handoff', args: '60' })
  await $.turn.complete({ turnId: 't', reason: 'answer', answer: 'done' })
  await waitFor(() => ran.includes('clear'))
  expect(written.size).toBe(1)
  expect(store.get('handedOff')).toEqual(['old-session'])
})

test('the handoff file starts with the writing-handoffs frontmatter', async ($, on) => {
  const written = new Map<string, string>()
  const ran: string[] = []
  stubHost(on, new Map(), written, ran)
  await $.command.run({ command: 'handoff-now', args: '' })
  await waitFor(() => ran.includes('clear'))
  const text = [...written.values()][0]!
  expect(text.startsWith('---\ndate: ')).toBe(true)
  expect(text).toContain('author: auto-handoff (session old-session)')
  expect(text).toContain('type: session')
  expect(text).toContain('status: in-progress')
  expect(text).toContain('project: "/proj"')
  expect(text).toContain('## Summary')
})

test('the first session shows a one-time notice about auto-clear', async ($, on) => {
  const store = new Map<string, unknown>()
  const toasts: string[] = []
  stubHost(on, store, new Map(), [], 'old-session', undefined, {
    'ui.toast': ($: any, e: any) => {
      toasts.push(JSON.stringify(e))
      return { value: undefined }
    },
  })
  on('session.usage', () => ({ value: { context: { window: 200000, percent: 1 } } }))
  on('command.register', () => ({ value: undefined }))
  on('clock.every', () => ({ value: undefined }))
  on('session.start', ($: any, e: any) => ({ cwd: e.cwd }))

  await $.session.start({ source: 'startup', cwd: '/proj' })
  await waitFor(() => toasts.some(t => t.includes('50%')))
  expect(toasts.find(t => t.includes('50%'))).toContain('/auto-handoff clear off')
  expect(store.get('introduced')).toBe(true)

  toasts.length = 0
  await $.session.start({ source: 'startup', cwd: '/proj' })
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(toasts.some(t => t.includes('50%'))).toBe(false)
})

test('a refused fallback model leaves the session untouched and says so', async ($, on) => {
  const store = new Map<string, unknown>()
  const written = new Map<string, string>()
  const ran: string[] = []
  const toasts: string[] = []
  stubHost(on, store, written, ran, 'old-session', undefined, {
    'model.fork': () => ({ value: { isAnswered: false, text: '', usage } }),
    'ui.toast': ($: any, e: any) => {
      toasts.push(JSON.stringify(e))
      return { value: undefined }
    },
  })
  on('session.messages', () => ({ value: [{ role: 'user', text: 'hi' }] }))
  // A throwing stub reaches the mod as a failed call, as a model refused by managed settings would.
  on('model.complete', () => {
    throw new Error('model not permitted')
  })

  await $.command.run({ command: 'handoff-now', args: '' })
  await waitFor(() => toasts.some(t => t.includes('untouched')))

  expect(written.size).toBe(0)
  expect(ran).toEqual([])
  const refused = toasts.find(t => t.includes('fallback summary model was refused'))
  expect(refused).toContain('nothing was cleared')
})

test('a prompt submitted while the handoff announces the clear still stops the /clear', async ($, on) => {
  const store = new Map<string, unknown>()
  const ran: string[] = []
  stubHost(on, store, new Map(), ran, 'old-session', undefined, {
    'store.set': async (_: any, e: any) => {
      store.set(e.key, e.value)
      // The user types just as the "Starting a fresh session" notice is recorded.
      if (e.key === 'lastHandoff' && String(e.value.text).includes('Starting a fresh session')) {
        await $.prompt.context({ blocks: [] })
      }
      return { value: undefined }
    },
  })
  on('prompt.context', () => ({ blocks: [] }))

  await $.command.run({ command: 'handoff-now', args: '' })
  await waitFor(() => String((store.get('lastHandoff') as { text: string } | undefined)?.text).includes('yourself'))

  expect(ran).not.toContain('clear')
})

test('the frontmatter quotes values, so a path with " #" stays valid YAML', async ($, on) => {
  const written = new Map<string, string>()
  const ran: string[] = []
  stubHost(on, new Map(), written, ran, 'old-session', { root: '/work/repo #2', listing: [] })
  await $.command.run({ command: 'handoff-now', args: '' })
  await waitFor(() => ran.includes('clear'))
  const text = [...written.values()][0]!
  expect(text).toContain('project: "/work/repo #2"')
  expect(text).toContain('reason: "requested with /handoff-now"')
})

test('a project folder that cannot be written falls back to the home folder', async ($, on) => {
  const store = new Map<string, unknown>()
  const written = new Map<string, string>()
  const ran: string[] = []
  stubHost(on, store, written, ran, 'old-session', undefined, {
    'fs.write': (_: any, e: any) => {
      if (String(e.path).includes('/proj/')) throw new Error('read-only file system')
      written.set(e.path, e.text)
      return { value: undefined }
    },
  })

  await $.command.run({ command: 'handoff-now', args: '' })
  await waitFor(() => ran.includes('clear'))

  expect([...written.keys()]).toEqual(['/Users/me/.claude/handoffs/handoff-1.md'])
  expect((pendingOf(store) as { path: string }).path).toBe('/Users/me/.claude/handoffs/handoff-1.md')
})

test('a Windows session root with backslashes matches the saved project root', async ($, on) => {
  const store = new Map<string, unknown>([
    ['pending:C:/proj', { path: '/proj/.claude/handoffs/x.md', sessionId: 'old-session', root: 'C:/proj', savedAt: 1_000_000 }],
  ])
  stubHost(on, store, new Map(), [], 'new-session', { root: 'C:\\proj\\', listing: [] })
  on('fs.read', () => ({ value: '## Summary\nShip it' }))
  on('prompt.context', () => ({ blocks: [] }))

  const result = await $.prompt.context({ blocks: [] })
  expect(result.blocks.map((b: { name: string }) => b.name)).toEqual(['handoff'])
})

test('a handoff in another session does not re-arm this one', async ($, on) => {
  const store = new Map<string, unknown>()
  const written = new Map<string, string>()
  const ran: string[] = []
  const ids = { current: 'aaaaaaaa-1' }
  stubHost(on, store, written, ran, 'unused', undefined, { 'session.id': () => ({ value: ids.current }) })
  stubTurnEnd(on, 90)
  const turnEnds = async (id: string) => {
    ids.current = id
    await $.turn.complete({ turnId: 't', reason: 'answer', answer: 'done' })
  }

  await turnEnds('aaaaaaaa-1')
  await waitFor(() => ran.length === 1)
  await turnEnds('bbbbbbbb-2')
  await waitFor(() => ran.length === 2)
  await turnEnds('aaaaaaaa-1')
  await new Promise(resolve => setTimeout(resolve, 30))

  expect(ran).toHaveLength(2)
})

test('a handoff in another project does not replace this project\'s pending handoff', async ($, on) => {
  const store = new Map<string, unknown>()
  const ran: string[] = []
  const ids = { current: 'aaaaaaaa-1' }
  const host = { root: '/x', listing: [] }
  stubHost(on, store, new Map(), ran, 'unused', host, { 'session.id': () => ({ value: ids.current }) })
  on('fs.read', () => ({ value: '## Summary\nShip it' }))
  on('prompt.context', () => ({ blocks: [] }))

  await $.command.run({ command: 'handoff-now', args: '' })
  await waitFor(() => ran.length === 1)
  ids.current = 'bbbbbbbb-2'
  host.root = '/y'
  await $.command.run({ command: 'handoff-now', args: '' })
  await waitFor(() => ran.length === 2)

  ids.current = 'cccccccc-3'
  host.root = '/x'
  const result = await $.prompt.context({ blocks: [] })
  expect(result.blocks.map((b: { name: string }) => b.name)).toEqual(['handoff'])
})

test('a failed automatic summary is not retried on every turn', async ($, on) => {
  const store = new Map<string, unknown>()
  let forks = 0
  stubHost(on, store, new Map(), [], 'old-session', undefined, {
    'model.fork': () => {
      forks += 1
      return { value: { isAnswered: false, text: '', usage } }
    },
  })
  on('session.messages', () => ({ value: [{ role: 'user', text: 'hi' }] }))
  on('model.complete', () => ({ value: { isAnswered: false, text: '', usage } }))
  stubTurnEnd(on, 90)

  await $.turn.complete({ turnId: 't', reason: 'answer', answer: 'done' })
  await waitFor(() => String((store.get('lastHandoff') as { text: string } | undefined)?.text).includes('nothing was cleared'))
  await $.turn.complete({ turnId: 't', reason: 'answer', answer: 'done' })
  await new Promise(resolve => setTimeout(resolve, 30))

  expect(forks).toBe(1)
  expect((store.get('lastHandoff') as { text: string }).text).toContain('/handoff-now')
})

const runningAgent = { id: 'a1', description: 'Build the Nutrition seeds', type: 'general-purpose', status: 'running', name: 'seeds' }

test('the automatic handoff waits while a background agent runs, then hands off once it is done', async ($, on) => {
  const store = new Map<string, unknown>()
  const written = new Map<string, string>()
  const ran: string[] = []
  let agents: unknown[] = [runningAgent]
  stubHost(on, store, written, ran, 'old-session', undefined, {
    'agent.list': () => ({ value: agents }),
  })
  stubTurnEnd(on, 90)

  await $.turn.complete({ turnId: 't', reason: 'answer', answer: 'done' })
  await waitFor(() => String((store.get('lastHandoff') as { text: string } | undefined)?.text).includes('waits'))
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(written.size).toBe(0)
  expect(ran).not.toContain('clear')

  agents = [{ ...runningAgent, status: 'completed' }]
  await $.turn.complete({ turnId: 't', reason: 'answer', answer: 'done' })
  await waitFor(() => ran.includes('clear'))
  expect(written.size).toBe(1)
})

test('/handoff-now saves but does not clear while a background agent runs', async ($, on) => {
  const store = new Map<string, unknown>()
  const written = new Map<string, string>()
  const ran: string[] = []
  stubHost(on, store, written, ran, 'old-session', undefined, {
    'agent.list': () => ({ value: [runningAgent] }),
  })

  await $.command.run({ command: 'handoff-now', args: '' })
  await waitFor(() => String((store.get('lastHandoff') as { text: string } | undefined)?.text).includes('not cleared'))
  await new Promise(resolve => setTimeout(resolve, 20))

  expect(written.size).toBe(1)
  expect(ran).not.toContain('clear')
  expect((store.get('lastHandoff') as { text: string }).text).toContain('background agent')
})

test('past the threshold mid-turn, one tool result tells the model to end the turn', async ($, on) => {
  stubHost(on, new Map(), new Map(), [])
  on('session.usage', () => ({ value: { context: { window: 200000, percent: 70 } } }))
  on('tool.call', () => ({ result: { stdout: 'ok' }, text: 'ok' }))

  const first = await $.tool.call({ tool: 'Bash', command: 'ls' } as any)
  const second = await $.tool.call({ tool: 'Bash', command: 'ls' } as any)

  expect(String(first.context?.[0])).toContain('end the turn')
  expect(second.context ?? []).toHaveLength(0)
})

test('under the threshold, tool results are left alone', async ($, on) => {
  stubHost(on, new Map(), new Map(), [])
  on('session.usage', () => ({ value: { context: { window: 200000, percent: 20 } } }))
  on('tool.call', () => ({ result: { stdout: 'ok' }, text: 'ok' }))

  const result = await $.tool.call({ tool: 'Bash', command: 'ls' } as any)
  expect(result.context ?? []).toHaveLength(0)
})

test('an automatic compaction keeps the running background agents in its summary', async ($, on) => {
  let instructions: string | undefined
  stubHost(on, new Map(), new Map(), [], 'old-session', undefined, {
    'agent.list': () => ({ value: [runningAgent, { ...runningAgent, id: 'a2', status: 'completed' }] }),
  })
  const messages = [{ role: 'user', text: 'summary', toolUses: [] }] as any
  on('session.compact', ($: any, e: any) => {
    instructions = e.instructions
    return { messages }
  })

  await $.session.compact({ trigger: 'auto', messages })
  expect(instructions).toContain('Build the Nutrition seeds')
  expect(instructions).toContain('id a1')
  expect(instructions).not.toContain('a2')

  instructions = undefined
  await $.session.compact({ trigger: 'manual', instructions: 'the plan', messages })
  expect(instructions).toBe('the plan')
})
