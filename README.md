# auto-handoff

A Claude Code mod (a plugin of JS/TS event hooks) that keeps an eye on your context window.

```
Context ███████░░░░░░░┃░░░░░░░░░░░░░░░░  23%  handoff at 50%        Cache warm 59m left
Last request · Input: 233k (99% cached, 2k new) · Output: 351
```

- **Context bar**, always above the prompt, scaled 0-100% with a red line at the handoff threshold (default 50%). Green, then yellow, then red as it nears and passes the line. The desktop app draws a vector bar; the terminal draws block characters.
- **Prompt-cache countdown** at the right of the bar: how long the cache stays warm after the last request.
- **Last request**: the full input size, how much of it came from the cache, how much was new, and the output tokens.
- **Auto-handoff**: when context passes the threshold, the mod asks the model for a handoff summary (from the cached transcript when it is still warm), saves it (see below), runs `/clear`, and loads the summary into the fresh session once. The summary uses the same sections and frontmatter as the `writing-handoffs` skill, so `writing-handoffs` can resume from it.

## Status

Early. The mod uses Claude Code's early-access plugin API, which may change without notice. Requires Claude Code 2.1.285 or later.

Seen working in Claude Code Desktop: the bar, the cache countdown, the per-request line, the slash commands, and the handoff itself (the summary is saved, the session is cleared, the summary is loaded into the fresh session, and the mod keeps running after the clear).
**Not yet verified live:** the threshold trigger (the handoff has been run from `/handoff-now`), and the home-folder slots used by scratch sessions (covered by tests only). If `/clear` is refused, the summary is still saved and the mod says so in the transcript.

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
- Not done, on purpose: cache keep-alive pings (they cost real money) and a session cost estimate (the mod cannot read prices).

## License

MIT, see [LICENSE](LICENSE).
