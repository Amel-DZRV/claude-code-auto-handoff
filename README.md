# auto-handoff

A Claude Code mod (a plugin of JS/TS event hooks) that keeps an eye on your context window.

```
Context ███████░░░░░░░┃░░░░░░░░░░░░░░░░  23%  handoff at 50%        Cache warm 59m left
Last request · Input: 233k (99% cached, 2k new) · Output: 351
Keepwarm 1h20m left · next ping in 38m · 1 ping, about $0.05 · last ping read 233k ($0.05)
```

- **Context bar**, always above the prompt, scaled 0-100% with a red line at the handoff threshold (default 50%). Green, then yellow, then red as it nears and passes the line. The desktop app draws a vector bar; the terminal draws block characters.
- **Prompt-cache countdown** at the right of the bar: how long the cache stays warm after the last request.
- **Last request**: the full input size, how much of it came from the cache, how much was new, and the output tokens.
- **Keepwarm** (opt-in): `/keepwarm 90m` sends a cheap ping while you are away so the prompt cache does not lapse, and a third bar row shows the window and the last ping. **Pings spend tokens**; see [Keepwarm](#keepwarm).
- **Cold-send estimate**: when you send a prompt into a cache that has gone cold, the mod logs what the rewrite will cost (and what a warm turn would have). It never holds the prompt back.
- **Auto-handoff**: when context passes the threshold, the mod asks the model for a handoff summary (from the cached transcript when it is still warm), saves it (see below), runs `/clear`, and loads the summary into the fresh session once. The summary uses the same sections and frontmatter as the `writing-handoffs` skill, so `writing-handoffs` can resume from it.

## Status

Early. The mod uses Claude Code's early-access plugin API, which may change without notice. Requires Claude Code 2.1.285 or later.

Seen working in Claude Code Desktop: the bar, the cache countdown, the per-request line, the slash commands, and the handoff itself (the summary is saved, the session is cleared, the summary is loaded into the fresh session, and the mod keeps running after the clear).
**Not yet verified live:** keepwarm (a real ping reading the real cache, the cold-send estimate, a handoff with a window armed; run `/keepwarm 1h every 1m` after a request to see one ping read the cache before relying on it), the threshold trigger (the handoff has been run from `/handoff-now`), and the home-folder slots used by scratch sessions (covered by tests only). If `/clear` is refused, the summary is still saved and the mod says so in the transcript.

## Install

From the marketplace in this repo (any machine, terminal or the Desktop app's Code tab):

```bash
claude plugin marketplace add Amel-DZRV/claude-code-auto-handoff
claude plugin install auto-handoff@amel-mods
```

Add `.claude/handoffs/` to your global gitignore (`git config --global core.excludesfile`) so handoffs are never committed.

Run `/reload-plugins` in an open session. Update later with `claude plugin marketplace update amel-mods`; bump `version` in `.claude-plugin/plugin.json` when you push a change.

Other options:

Hot reloading, for trying it out: copy this folder to `~/.claude/dev-mods/<session-id>/auto-handoff/` and answer "Enable for this session" when Claude Code asks.

For every session: clone the repo and add its absolute path to the `env` block of `~/.claude/settings.json` (several folders are separated by `;` on Windows, `:` elsewhere):

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "C:\\dev\\claude-code-auto-handoff"
  }
}
```

New sessions load the mod from that folder and reload it when a file in it is saved. In a terminal you can use `claude --plugin-dir <folder>` instead.

Do not keep two copies of the mod loaded at once. They share a name, and an older copy can answer the commands before the newer one.

## Commands

| Command | What it does |
| --- | --- |
| `/auto-handoff` or `status` | Settings and the last handoff's outcome |
| `/auto-handoff <percent>` | Set the threshold (5 to 95) |
| `/auto-handoff on` / `off` | Turn auto-handoff on or off |
| `/auto-handoff clear on` / `off` | Run `/clear` automatically after saving |
| `/auto-handoff resume on` / `off` | Send a "continue" prompt in the fresh session |
| `/auto-handoff bar on` / `off` | Show or hide the bar |
| `/auto-handoff ttl <minutes>` | How long the prompt cache lives after its last use (default 60; the API gives 5 or 60) |
| `/auto-handoff tokens` | The last 10 requests, plus main-thread and subagent totals |
| `/handoff-now` | Write the handoff now |
| `/keepwarm <window>` | Keep the prompt cache warm for a window such as `90m`, `2h` or `2h30m` (up to 24h). Pings spend tokens |
| `/keepwarm <window> every <period>` | Ping more often than the default, at least `1m`; applies to that window only |
| `/keepwarm` or `status` | Where the window stands, or the cost warning when it is off. Never arms pings |
| `/keepwarm off` (also `stop`, `cancel`) | Cancel the window and its pings |

## Keepwarm

```
/keepwarm 90m
keepwarm on for 1h30m: a ping each time the cache has sat idle for 50m, at most 1. The next ping is in 50m. Pings spend tokens: each one re-reads the whole cached context and gets a one-word answer. Each re-reads about 201k tokens, about $0.04 before its answer; up to 1 in this window is about $0.04. A cold rewrite of the same context would cost about $0.80. /keepwarm off stops it; a handoff that clears the session does too.
```

The prompt cache lasts about an hour after its last use (the `ttl` setting). Run `/keepwarm 90m` before a break and, after the cache has been idle for 50 minutes (ten minutes short of the ttl; a fifth of the ttl for a short one, never closer than a minute), the mod sends one ping. The ping is a fork over the session's own cached transcript with a fixed one-word prompt, so it reads the cache and resets its clock. Then it waits another 50 minutes, until the window ends.

**Pings cost money.** Every ping re-reads the whole cached context (a cache read, about a tenth of the input price) and bills whatever the model answers, since a fork has no output cap. The reply to `/keepwarm` prints the estimate for the current context and model, next to what a cold rewrite would cost, so you can judge whether the window is worth it. The mod uses list prices it carries in `hooks/keepwarm.ts` (September 2026); on a subscription the dollars are a yardstick, not the bill, and a model it has no price for prints no dollars. Pick a window you expect to return within.

Safety limits:

- Nothing is armed by default and bare `/keepwarm` only reports. A window needs an explicit duration, at most 24 hours.
- A window sends at most 100 pings.
- Every ping's reading is checked: a ping that reads nothing, or writes a tenth of what it reads or more, means the cache was already gone, so the window stops (the ping already paid for a rewrite; more would pay again).
- Any failure stops the window with the reason (a refused or interrupted call, an API error, an empty reply), and it is never retried.
- A cache that is already cold is not pinged. Pings wait for your next request to warm it. The same goes for a new transcript after a compaction or `/clear`.
- Pings count from the cache's last use, and the main thread's requests (also inside a long turn) push the next ping back. Subagent requests do not.
- The window belongs to its session. It survives a plugin reload, and another session never inherits it.

### With auto-handoff

- A ping is not a turn. It appends nothing to the transcript, adds no prompt to the model's context, does not move the context bar, and never runs the threshold check, so a ping cannot start a handoff. Pings are also kept out of the "Last request" line and the request list in `/auto-handoff tokens`; that command shows them on a line of their own.
- A ping that comes due while a handoff is writing its summary waits (the summary reads the same cache and warms it too).
- A handoff that is about to `/clear` ends the window first, with a toast: the old cache is being thrown away, so another ping would only warm it. A handoff that leaves the session running (`clear off`, a background agent still running, or a prompt typed meanwhile) leaves the window running. A `/clear` you type ends it too.
- A ping counts as cache use, so the bar's "Cache warm" countdown restarts after each ping, and a cache kept warm raises no cold-send estimate.
- `/auto-handoff ttl <minutes>` changes the ping period with it.

## Develop

```
claude plugin validate .
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test .
```

The test command refuses to run hooks modules without that variable while the plugin API is early access.

`claude plugin test` runs the files in `tests/` against the engine with stubbed host calls.

## Notes

- Percent comes from `$.session.usage().context.percent`; request tokens come from the API's usage on each `turn.step`.
- The cache countdown assumes a cache lifetime (the `ttl` setting); the mod cannot read the real value.
- Where the handoff is saved: in a project, `<project>/.claude/handoffs/YYYY-MM-DD-HHMMSS-auto-handoff-<session>.md`, the same folder the `writing-handoffs` skill uses. Add `.claude/handoffs/` to the repo's `.gitignore` (or your global one): handoffs summarise your conversation and should not be committed. A session with no project folder works in a scratch workspace that is deleted with the session, so it saves to `~/.claude/handoffs/handoff-1.md` to `handoff-5.md` instead, reusing the oldest slot when all five exist.
- The automatic handoff only runs when a turn ends, right after the last request, so the prompt cache is warm and the summary reuses it. The threshold is the only knob; there is no separate "early" setting. `/handoff-now` can run any time and warns when the cache is cold.
- Claude Code also compacts the context on its own when it gets full. Keep the threshold below that point, or the built-in compaction runs first and the handoff never fires. Check `/config` for the compaction setting on your version.
- A long turn can pass the threshold well before it ends. From then on, one tool result tells the model to finish the step it is on and end the turn, so the handoff can run before the built-in compaction does.
- Background agents: `/clear` would cut off subagents that are still running. At the threshold, the handoff waits until they finish, saying so once; each agent's result arrives as a new turn, and the check runs again when that turn ends. `/handoff-now` still saves the file, but does not clear while agents run. If an automatic compaction gets there first, its summary is told to keep the running agents (id, name, task) so the compacted session still waits for them.
- Managed settings can restrict which models a plugin may call. If the fallback summary model is refused, the mod says so and leaves the session untouched.
- Keepwarm and the cold-send estimate use a built-in price table (cache read, 1-hour cache write, output, per million tokens), not prices read from your account, so the dollar figures are estimates and can go stale. The cache-write figure is an upper bound: it counts the last request's whole prompt. A resumed session has no estimate until its first request, and the mod cannot see the real cache, only the clock.
- Not done, on purpose: refusing or delaying a cold send, arming keepwarm automatically after a cold write, an "always on" setting, and a session cost total. Every one of them spends or withholds something without being asked.

## License

MIT, see [LICENSE](LICENSE).
