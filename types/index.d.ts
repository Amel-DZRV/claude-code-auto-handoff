export type ContextBar = {
  /** Context window used, 0 to 100; null until the session's first response. */
  percent: number | null
  /** The handoff mark, 5 to 95. */
  threshold: number
  isEnabled: boolean
  isShown: boolean
}

/** One model request, as the API reported its usage. */
export type RequestRow = {
  /** When the response arrived, ms since the epoch. */
  at: number
  model: string
  /** Set for a subagent's request; absent on the main thread. */
  agentId?: string
  /** Uncached input tokens. */
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export type Requests = {
  /** The latest requests, oldest first, capped. */
  rows: RequestRow[]
  /** Minutes the prompt cache lives after its last use. */
  ttlMinutes: number
  /** Bumped by a timer so the cache countdown redraws. */
  tick: number
}

declare module 'claude-code' {
  interface PluginState {
    'auto-handoff': { bar: ContextBar; requests: Requests }
  }
}
