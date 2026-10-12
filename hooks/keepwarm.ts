// The pure parts of /keepwarm: durations, prices and the ping schedule. No host calls live here.

export const MIN_MS = 60_000
export const MIN_EVERY_MS = MIN_MS
export const MAX_WINDOW_MS = 24 * 60 * MIN_MS
// Pings stop after this many in one window, whatever the window says.
export const MAX_PINGS = 100
// Below this many tokens a cold rewrite is cheap enough that the estimate is noise.
export const BIG_TOKENS = 50_000
export const PING_PROMPT = 'Reply with the single word: warm'

// $ per million tokens, [cache read, 1h cache write, output], list prices September 2026.
// Longer family names first: a model id matches the first row it contains. Prices change;
// check them against Anthropic's pricing page, and an unknown model prints no dollars.
const PRICES: [string, number, number, number][] = [
  ['fable-5-1', 0.25, 20, 50],
  ['fable-5', 1, 20, 50],
  ['opus-5', 0.5, 10, 25],
  ['opus-4', 0.5, 10, 25],
  ['sonnet-5', 0.2, 4, 10],
  ['sonnet', 0.3, 6, 15],
  ['haiku', 0.1, 2, 5],
]

export type Price = { read: number; write: number; output: number }
export type PingUsage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

export const priceOf = (model: string | undefined): Price | undefined => {
  const id = (model ?? '').toLowerCase().replace(/[\s.]+/g, '-')
  const row = PRICES.find(([family]) => id.includes(family))
  return row === undefined ? undefined : { read: row[1], write: row[2], output: row[3] }
}

// "90m", "2h", "2h30m"; anything else is undefined, and so is zero.
export const parseDuration = (text: string): number | undefined => {
  const match = /^(?:(\d+)h)?(?:(\d+)m)?$/.exec(text.trim().toLowerCase())
  if (match === null || (match[1] === undefined && match[2] === undefined)) return undefined
  const ms = (Number(match[1] ?? 0) * 60 + Number(match[2] ?? 0)) * MIN_MS
  return ms > 0 ? ms : undefined
}

export const usd = (amount: number | undefined): string =>
  amount === undefined ? 'n/a' : `$${amount >= 100 ? amount.toFixed(0) : amount.toFixed(2)}`

// What the API bills for one fork: the cache read, any cache write, uncached input at the base rate
// (half the 1h write rate) and the answer, which a fork does not cap.
export const pingCost = (u: PingUsage, price: Price | undefined): number | undefined =>
  price === undefined
    ? undefined
    : (u.cache_read_input_tokens * price.read +
        u.cache_creation_input_tokens * price.write +
        (u.input_tokens * price.write) / 2 +
        u.output_tokens * price.output) /
      1e6

// The 5-minute cache write costs 1.25x the base input rate, the 1-hour write 2x.
const writeRate = (price: Price, ttlMinutes: number): number => (ttlMinutes > 5 ? price.write : price.write * 0.625)

// Re-writing `tokens` of context into a cold cache.
export const coldRewriteCost = (tokens: number, model: string | undefined, ttlMinutes: number): number | undefined => {
  const price = priceOf(model)
  return price === undefined ? undefined : (tokens * writeRate(price, ttlMinutes)) / 1e6
}

// Reading `tokens` of context from a warm cache: the floor of one ping.
export const warmReadCost = (tokens: number, model: string | undefined): number | undefined => {
  const price = priceOf(model)
  return price === undefined ? undefined : (tokens * price.read) / 1e6
}

// A warm ping reads the prefix and writes only its own message; a write of a tenth of the
// read or more means the prefix broke and the ping paid for a rewrite.
export const isWarmPing = (u: PingUsage): boolean =>
  u.cache_read_input_tokens > 0 && u.cache_creation_input_tokens < 0.1 * u.cache_read_input_tokens

// How long after the cache's last use the ping goes: ten minutes inside a one-hour cache,
// a fifth of the lifetime inside a short one, never closer than a minute.
export const defaultEveryMs = (ttlMinutes: number): number => {
  const ttl = ttlMinutes * MIN_MS
  return ttl - Math.max(MIN_MS, Math.min(10 * MIN_MS, ttl / 5))
}

// A custom period can only be shorter than the default: a longer one would let the cache lapse.
export const effectiveEveryMs = (customMs: number | undefined, ttlMinutes: number): number =>
  Math.max(MIN_EVERY_MS, Math.min(customMs ?? Infinity, defaultEveryMs(ttlMinutes)))
