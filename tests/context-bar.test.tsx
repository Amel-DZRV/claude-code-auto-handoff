import { expect, test } from 'claude-code/testing'

const BAND = {
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 6,
    bodyColumns: 100,
    scroll: { bodyRows: 5, offset: 0, isAtTop: true, isAtBottom: true },
  },
} as const

const NOW = 1_700_000_000_000
const time = { now: NOW }
const USAGE = { model: 'm', input_tokens: 400, output_tokens: 840, cache_read_input_tokens: 11_600, cache_creation_input_tokens: 300 }

const stubSession = (on: any, percent: number | undefined) => {
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('session.usage', () => ({ value: { context: { window: 200000, percent } } }))
  on('ui.toast', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  time.now = NOW
  on('clock.now', () => ({ value: time.now }))
  on('turn.step', async function* () {
    return { turnId: 't', index: 0, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: USAGE }
  })
  on('clock.every', () => ({ value: undefined }))
}

test('the bar shows the used percent and the handoff mark', async ($, on) => {
  stubSession(on, 30)
  on('session.start', ($: any, e: any) => ({ cwd: e.cwd }))
  await $.session.start({ source: 'startup', cwd: 'C:/proj' })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'auto-handoff', surface, ...BAND })
    expect(await ui.find({ type: 'Text', text: /handoff at 50%/ })).toBeDefined()
    if (surface === 'terminal') {
      expect(await ui.find({ type: 'Text', text: /┃/ })).toBeDefined()
    } else {
      // The desktop draws a vector bar: fill to 30%, red line at 50% of 300px.
      const svg = await ui.find({ type: 'Svg' })
      expect(svg).toBeDefined()
      const source = (svg as any).props.source as string
      expect(source).toContain('width="90"')
      expect(source).toContain('x="149"')
    }
    await ui.unmount()
  }
})

test('the bar reads the live percent after a session starts', async ($, on) => {
  stubSession(on, 62)
  on('session.start', ($: any, e: any) => ({ cwd: e.cwd }))
  await $.session.start({ source: 'startup', cwd: 'C:/proj' })
  const ui = await $.ui.mount({ plugin: 'auto-handoff', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: /62%/ })).toBeDefined()
  await ui.unmount()
})

// A request that finished `ago` ms before the stubbed clock's present.
const seedRequest = async ($: any, ago: number) => {
  time.now = NOW - ago
  // A streaming event runs once its stream is read to the end.
  for await (const _chunk of $.turn.step({ turnId: 't', index: 0, model: 'm', messageCount: 1 })) void _chunk
  time.now = NOW
}

test('the bar counts the cache down from the last request and shows its tokens', async ($, on) => {
  stubSession(on, 30)
  on('session.start', ($: any, e: any) => ({ cwd: e.cwd }))
  await $.session.start({ source: 'startup', cwd: 'C:/proj' })
  await seedRequest($, 10 * 60_000)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'auto-handoff', surface, ...BAND })
    expect(await ui.find({ type: 'Text', text: /Cache warm 50m left/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Last request · Input: 12\.3k \(94% cached, 700 new\) · Output: 840/ })).toBeDefined()
    await ui.unmount()
  }
})

test('the bar says the cache is cold once the ttl has passed', async ($, on) => {
  stubSession(on, 30)
  on('session.start', ($: any, e: any) => ({ cwd: e.cwd }))
  await $.session.start({ source: 'startup', cwd: 'C:/proj' })
  await seedRequest($, 10 * 60_000)
  await $.command.run({ command: 'auto-handoff', args: 'ttl 5' })
  const ui = await $.ui.mount({ plugin: 'auto-handoff', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: /Cache cold 5m/ })).toBeDefined()
  await ui.unmount()
})
