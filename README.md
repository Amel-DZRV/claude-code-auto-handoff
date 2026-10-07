# auto-handoff

A Claude Code mod (a plugin of JS/TS event hooks) that keeps an eye on your context window.

```
Context ████████░░░░░░┃░░░░░░░░░░░░░░░  23%  handoff at 50%        Cache warm 59m left
Last request · Input: 233k (99% cached, 2k new) · Output: 351
```

- **Context bar**, always above the prompt, scaled 0-100% with a red line at the handoff threshold (default 50%). Green, then yellow, then red as it nears and passes the line. The desktop app draws a vector bar; the terminal draws block characters.
- **Prompt-cache countdown** at the right of the bar: how long the cache stays warm after the last request.
- **Last request**: the full input size, how much of it came from the cache, how much was new, and the output tokens.
- **Auto-handoff**: when context passes the threshold, the mod asks the model for a handoff summary (from the cached transcript when it is still warm), saves it (see below), runs `/clear`, and loads the summary into the fresh session once.

## Status

Early. The mod uses Claude Code's early-access plugin API, which may change without notice.

Seen working in Claude Code Desktop: the bar, the cache countdown, the per-request line, the slash commands, and the handoff itself (the summary is saved, the session is cleared, the summary is loaded into the fresh session, and the mod keeps running after the clear).
**Not yet verified live:** the threshold trigger (the handoff has been run from `/handoff-now`), and the home-folder copies of the handoff (covered by tests only). If `/clear` is refused, the summary is still saved and the mod says so in the transcript.

## Install

Hot reloading, for trying it out: copy this folder to `~/.claude/dev-mods/<session-id>/auto-handoff/` and answer "Enable for this session" when Claude Code asks.

For every session: point `CLAUDE_CODE_PLUGIN_DIRS` at the folder (or `claude --plugin-dir <folder>` in a terminal).

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
claude plugin test .
```

`claude plugin test` runs the files in `tests/` against the engine with stubbed host calls.

## Notes

- Percent comes from `$.session.usage().context.percent`; request tokens come from the API's usage on each `turn.step`.
- The cache countdown assumes a cache lifetime (the `ttl` setting); the mod cannot read the real value.
- Where the handoff is saved: in a project, `<project>/.claude/handoff.md`. Every handoff also gets a copy in `~/.claude/handoffs/handoff-1.md` to `handoff-5.md`; when all five exist the oldest is overwritten. A session with no project folder works in a scratch workspace that is deleted with the session, so it uses only the home copy.

## License

MIT, see [LICENSE](LICENSE).
