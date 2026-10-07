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
) => {
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
  on('session.root', () => ({ value: 'C:\\proj' }))
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
