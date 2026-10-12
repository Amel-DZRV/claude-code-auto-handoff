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

/** The /keepwarm window: pings that keep the prompt cache from lapsing while the user is away. */
export type Keepwarm = {
  /** When the window ends, ms since the epoch; null when keepwarm is off or has stopped. */
  until: number | null
  /** A shorter ping period than the default, ms; null for the default. */
  customEveryMs: number | null
  /** Pings sent in this window. */
  pings: number
  /** Dollars those pings cost by the list prices; a model with no known price counts as 0. */
  spent: number
  /** The latest ping, as the API reported it; kept after a stop so the reason has its receipt. */
  lastPing: { at: number; read: number; write: number; cost: number | null } | null
  /** Why the window ended by itself or at a handoff; null while it runs and after /keepwarm off. */
  stopped: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'auto-handoff': { bar: ContextBar; requests: Requests; keepwarm: Keepwarm }
  }
}
