import { expect, test } from 'claude-code/testing'

const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

const waitFor = async (isDone: () => boolean) => {
  for (let i = 0; i < 200 && !isDone(); i++) await new Promise(resolve => setTimeout(resolve, 5))
}

const stubHost = (
  on: any,
  store: Map<string, unknown>,
  written: Map<string, string>,
  ran: string[],
  sessionId = 'old-session',
  host: { root: string; listing: { name: string; mtimeMs: number }[] } = { root: 'C:\\proj', listing: [] },
) => {
  on('env.get', () => ({ value: 'C:\\Users\\me' }))
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
  on('model.fork', () => ({ value: { isAnswered: true, text: '## Goal\nShip it', usage } }))
  on('fs.write', ($: any, e: any) => {
    written.set(e.path, e.text)
    return { value: undefined }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('command.run', ($: any, e: any) => {
    ran.push(e.command)
    return { text: '' }
  })
}

test('/handoff-now writes the file, saves the pending marker and clears', async ($, on) => {
  const store = new Map<string, unknown>()
  const written = new Map<string, string>()
  const ran: string[] = []
  stubHost(on, store, written, ran)

  const answer = await $.command.run({ command: 'handoff-now', args: '' })
  await waitFor(() => ran.includes('clear'))

  expect(answer.text).toBe('Writing the handoff…')
  const [path, text] = [...written.entries()][0] ?? ['', '']
  expect(path.replace(/\\/g, '/')).toMatch(/C:\/proj\/\.claude\/handoff\.md$/)
  expect(text).toContain('## Goal')
  expect(ran).toEqual(['clear'])
  expect((store.get('pending') as { sessionId: string }).sessionId).toBe('old-session')
  expect([...written.keys()].map(p => p.replace(/\\/g, '/'))).toContain('C:/Users/me/.claude/handoffs/handoff-1.md')
})

test('with no project folder the handoff is saved to the home folder and loaded from there', async ($, on) => {
  const store = new Map<string, unknown>()
  const written = new Map<string, string>()
  const ran: string[] = []
  const host = { root: 'C:\\Users\\me\\AppData\\Roaming\\Claude\\scratch-workspaces\\a\\b\\scratch-1', listing: [] }
  stubHost(on, store, written, ran, 'old-session', host)

  await $.command.run({ command: 'handoff-now', args: '' })
  await waitFor(() => ran.includes('clear'))

  const paths = [...written.keys()].map(p => p.replace(/\\/g, '/'))
  expect(paths).toEqual(['C:/Users/me/.claude/handoffs/handoff-1.md'])
  expect((store.get('pending') as { path: string }).path.replace(/\\/g, '/')).toBe(paths[0])
})

test('a full set of kept handoffs reuses the oldest slot', async ($, on) => {
  const written = new Map<string, string>()
  const ran: string[] = []
  const host = {
    root: 'C:\\Users\\me\\AppData\\Roaming\\Claude\\scratch-workspaces\\a\\b\\scratch-1',
    listing: [1, 2, 3, 4, 5].map(n => ({ name: `handoff-${n}.md`, mtimeMs: n === 3 ? 10 : 100 + n })),
  }
  stubHost(on, new Map(), written, ran, 'old-session', host)

  await $.command.run({ command: 'handoff-now', args: '' })
  await waitFor(() => ran.includes('clear'))

  expect([...written.keys()].map(p => p.replace(/\\/g, '/'))).toEqual(['C:/Users/me/.claude/handoffs/handoff-3.md'])
})

test('the next session loads the handoff once', async ($, on) => {
  const store = new Map<string, unknown>([
    ['pending', { path: 'C:/proj/.claude/handoff.md', sessionId: 'old-session', savedAt: 1_000_000 }],
  ])
  stubHost(on, store, new Map(), [], 'new-session')
  on('fs.read', () => ({ value: '## Goal\nShip it' }))
  on('prompt.context', () => ({ blocks: [{ name: 'currentDate', text: 'today' }] }))

  const first = await $.prompt.context({ blocks: [] })
  expect(first.blocks.map((b: { name: string }) => b.name)).toEqual(['currentDate', 'handoff'])
  expect(store.has('pending')).toBe(false)

  const second = await $.prompt.context({ blocks: [] })
  expect(second.blocks.map((b: { name: string }) => b.name)).toEqual(['currentDate'])
})

test('/auto-handoff sets the threshold', async ($, on) => {
  stubHost(on, new Map(), new Map(), [])
  const answer = await $.command.run({ command: 'auto-handoff', args: '40' })
  expect(answer.text).toContain('threshold 40%')
})
