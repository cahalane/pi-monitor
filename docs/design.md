# pi-monitor design notes

This is the working design record from building the extension, kept because the reasoning behind the
delivery scheduler is not obvious from the code. It was written as a plan and then amended after
review and after live testing; the "Revisions after review" and "Implementation notes (as built)"
sections at the end are authoritative where they contradict earlier text.

Goal: a pi extension giving the model Claude Code's Monitor capability — start a background
watcher (shell command or WebSocket), and have each new line/event pushed into the live session
as an interjection, instead of the model polling `bg_logs` in a loop.

## Why an extension, and what pi gives us

Researched `docs/extensions.md` in full plus `pi-background-tasks` as prior art. Findings that
shape the design:

- `pi.sendMessage({customType, content, display, details}, {deliverAs, triggerTurn})` is the only
  channel that reaches the model asynchronously. `deliverAs: "steer"` queues while streaming and
  delivers after the current turn's tool calls finish, before the next LLM call — that is our
  interjection. `triggerTurn: true` starts a turn when idle.
- There is **no** true mid-tool-execution interrupt in pi, and no zero-token channel the model can
  see (`pi.appendEntry` is TUI-only). So "precise timing" means: between tool calls, not mid-call.
- `execute()`'s `onUpdate` dies when the tool call returns, so the start tool must return
  immediately and the watcher must own delivery.
- Live handles cannot survive `session_start` (fires on `/new`, `/resume`, `/fork`, `/reload`).
  Monitors are session-scoped, like Claude's.
- `pi-background-tasks` sends its terminal notification with
  `{deliverAs: 'followUp', triggerTurn: task.triggerOnCompletion}` and retries after 100 ms if
  `sendMessage` throws (`src/core/registry.ts:2291-2334`). Copy that shape.
- pi has no Bash allow/deny rule engine to inherit; gating is per-extension (`ui.confirm`).

## Location and layout

Installed as a pi package; during development it lived at `~/.pi/agent/extensions/monitor/`

```
index.ts        extension entry: tools, /monitor command, widget, lifecycle
registry.ts     MonitorRegistry — lifecycle, batching, caps, delivery, terminal notices
sources.ts      CommandSource (child process) and WebSocketSource
pipeline.ts     pure: line filter (match/ignore), dedupe, per-line and per-flush truncation
ws-guard.ts     pure-ish: ws URL validation, subprotocol tokens, SSRF address denylist
format.ts       pure: <monitor-event> / <monitor-ended> rendering
README.md       usage, limits, security notes
tests/*.test.ts node --test --experimental-strip-types over the pure modules
```

Imports available: `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai` (`StringEnum`),
`typebox` (`Type`), `@earendil-works/pi-tui`, node builtins. No new npm deps (node 22.23 has a
global `WebSocket`).

## Tools

### `monitor` — start a watch
| param | type | default | notes |
|---|---|---|---|
| `name` | string | required | short label for UI and event headers |
| `command` | string | — | shell command; mutually exclusive with `ws` |
| `ws` | `{url, protocols?}` | — | `ws://`/`wss://` only |
| `cwd` | string | session cwd | command only |
| `timeoutMs` | number | 300000 | watch ends at deadline |
| `persistent` | boolean | false | ignore the deadline |
| `match` | string | — | JS regex; only matching lines become events |
| `ignore` | string | — | JS regex; drops matching lines (applied after `match`) |
| `dedupe` | boolean | false | suppress consecutive identical lines |
| `batchMs` | number | 400 | coalesce lines in this window into one interjection; 0 = immediate |
| `maxEvents` | number | 200 | auto-stop after this many delivered lines |
| `wake` | boolean | true | `triggerTurn` — react when idle rather than waiting for my next prompt |
| `deliverAs` | enum steer/followUp/nextTurn | steer | escape hatch for noisy watches |

Returns immediately: monitor id (`mon_1`), resolved source, caps in effect. Rejects: both/neither
of `command`/`ws`, invalid regex, bad ws URL, more than 8 live monitors.

### `monitor_list`
Snapshot of live and recently ended monitors: id, name, source, status, events delivered, bytes
injected, uptime, last event age. Cheap — the widget is the primary display.

### `monitor_stop`
`id` or `"all"`. Kills the process group / closes the socket and returns a final summary.

## Delivery and context discipline

This is the part that earns the feature: the model must not get the raw firehose.

- Lines pass `match` → `ignore` → `dedupe` → per-line truncation (2000 chars, tail-truncated with
  a marker) → batch buffer.
- Flush per `batchMs` into one `sendMessage`, capped at 50 lines and 8 KiB per flush; excess is
  elided in the middle with `… N lines elided`.
- Per monitor: `maxEvents` lines and 256 KiB total injected. Hitting either auto-stops the monitor
  and sends the terminal notice saying which cap fired.
- Flushes are serialised per monitor; a failed `sendMessage` retries once after 100 ms, then drops
  the batch and `ui.notify`s (never throw into the event loop).
- Event payload:
  ```
  <monitor-event monitor="mon_3" name="ci">
    <source>command: gh pr checks 1234 --watch</source>
    <lines>3</lines>
    <output>
  ...
    </output>
  </monitor-event>
  ```
  `display: true`, `details: {monitorId, name, lines, droppedLines}`.
- Terminal notice `<monitor-ended>` on exit / close / timeout / cap / explicit stop, with
  `deliverAs: "followUp"` and `triggerTurn` = `wake`, carrying exit code or ws close code, totals,
  and explicit "do not re-run to check; it is finished" guidance.

## Sources

**Command.** `spawn(shell, ["-c", command], {cwd, detached: true})` so we own a process group;
stdout and stderr merged and split on newlines with a carry buffer (partial last line flushed on
exit). Stop = `SIGTERM` to `-pgid`, `SIGKILL` after 3 s. Timeout unless `persistent`.

**WebSocket.** Global `WebSocket`. Validation before connect: `ws:`/`wss:` scheme, ASCII only, no
whitespace, no embedded credentials, unique valid subprotocol tokens. Then `dns.lookup(all)` and
reject loopback, private (10/8, 172.16/12, 192.168/16), link-local (169.254/16 incl. cloud
metadata), CGNAT 100.64/10, IPv6 `::1`, `fc00::/7`, `fe80::/10`, and IPv4-mapped forms of the
above. Frame handling per the Claude spec: text → one event; binary → `[binary frame, N bytes]`
placeholder; >1 MiB → end the watch; close → end with the close code.

Approval: `ws` connects prompt `ctx.ui.confirm` once per call when a UI is present; with no UI they
are refused unless `PI_MONITOR_ALLOW_WS=1`. Command monitors are not prompted — they sit at the
same trust level as this environment's `bash`/`bg_run`, and pre-tool hooks still see the call.
Documented in the README rather than silently assumed.

## UI and lifecycle

- `ctx.ui.setStatus("monitor", "◉ 2 watching")` and `ctx.ui.setWidget("monitor", lines)` listing
  each live monitor with event count and last-event age; both cleared when none are live.
- `/monitor list | stop <id> | stop all | tail <id> [n]`. `tail` reads a per-monitor ring buffer
  (last 200 lines) and renders through `appendEntry` + `registerEntryRenderer` so it costs no
  tokens.
- `registerMessageRenderer("monitor-event", …)` for a compact transcript line instead of raw XML.
- Nothing starts in the extension factory. `session_shutdown` stops everything idempotently.
- No resurrection across sessions; `monitor_list` after `/resume` is empty and says so.

## Verification

1. `node --test --experimental-strip-types tests/` over `pipeline.ts`, `ws-guard.ts`, `format.ts`
   → filter/dedupe/truncation boundaries, elision arithmetic, every denied address class, malformed
   URLs, subprotocol validation.
2. Type check: `npx tsc --noEmit` against the pi types if a tsconfig can resolve them; otherwise
   load-check by starting pi with the extension and confirming the tools register.
3. Live smoke through `pi --mode json -p` in the background: a monitor over
   `for i in $(seq 1 5); do echo "line $i"; sleep 1; done` while the agent does other work; assert
   `monitor-event` messages arrive interleaved and a `monitor-ended` lands with exit 0.
4. Manual interactive check of the widget, `/monitor` subcommands, and `session_shutdown` cleanup
   (no orphaned processes: `pgrep -g` after quit).

## Not in scope

Plugin-declared auto-start monitors, restart across sessions, a native directory-watch source
(`fswatch`/`tail -F` via `command` covers it), and per-host "always allow" for WebSockets.

## Revisions after review (Sol)

The review found seven must-fixes. All accepted; this section overrides the text above.

1. **Delivery model stated exactly.** `steer` delivers after the current assistant turn finishes
   *all* its tool calls, before the next LLM call — not between individual tool calls. `followUp`
   waits until the agent has no tool calls left. `triggerTurn` only starts a run when idle; it never
   creates a concurrent turn.
2. **Turn-aware scheduler.** At most one undelivered notification per monitor: further lines
   coalesce into the buffer until a `turn_end`/`agent_settled` shows the previous one was consumed.
   One automatic wake outstanding registry-wide, a minimum 5 s wake interval, and a cap of 8
   consecutive monitor-triggered turns — hitting it suspends waking and says so once. Real user
   input (`before_agent_start`) resets the counter.
3. **No retained tool `ctx`.** `execute()` hands plain config to the registry. The UI context comes
   from `session_start` and is dropped on `session_shutdown`; every timer and source callback checks
   a generation counter, so a stale runtime cannot talk to a replaced session.
4. **Shutdown awaits termination.** Stop clears timers, detaches listeners, `SIGTERM`s the process
   group, escalates to `SIGKILL` after 3 s, and awaits `close` with a 5 s deadline. No model-facing
   notices are sent during shutdown. Windows gets plain `child.kill()` and is documented as
   best-effort.
5. **Payload cannot break the envelope.** Every output line is prefixed with `| `, so nothing in
   the stream can close the block or forge a notice, and the header marks it untrusted data.
6. **WebSocket SSRF closed by pinning.** Resolve once, validate every address, then connect through
   an `undici` dispatcher whose `lookup` returns only that address, keeping SNI and certificate
   verification on the hostname. Without `undici` present, ws monitors refuse to start unless
   `PI_MONITOR_ALLOW_UNPINNED_WS=1`.
7. **Change-oriented `poll` source in v1.** `{command, intervalMs}` reruns a command and emits only
   when its canonical output changes, with `until` ending the watch on a terminal pattern. This is
   the CI/PR case, and line-streaming served it badly.

Also applied: per-monitor budget cut to 64 KiB / 100 events with a 256 KiB session-wide budget;
default 20 lines per flush (50 is the hard maximum); compact one-line header instead of the XML
envelope; `/monitor tail`, entry renderers and the ring-buffer transcript view cut from v1 (the
widget and `/monitor list|stop` stay); README states plainly that enabling the extension grants a
second arbitrary-command execution path that pre-tool hooks can gate but Bash policy does not.

## Implementation notes (as built)

Deviations and additions found while implementing and smoke-testing:

- **Line sequence numbers.** Every accepted line gets a monotonic per-monitor number, and event
  headers carry the range (`monitor mon_1 "ci" — lines 2-5`). A live smoke test showed the model
  guessing it had missed output when a batch arrived out of proportion to the totals; the range
  makes any gap checkable instead of inferred.
- **Deferred flush instead of a wake-less send.** When a flush is ready inside the 5 s minimum wake
  interval, the buffer is held and the flush rescheduled. Sending it with `triggerTurn: false`
  queued a message with nothing scheduled to read it, so output sat invisible until an unrelated
  turn started.
- **`hasWoken` flag rather than a `lastWakeAt !== 0` sentinel**, which collides with a test clock
  starting at 0.
- **`buildBatch` composes from a keep-count.** The first version spliced a line out and the
  recomputed elision marker back in, so the array never shrank and the byte-cap loop never
  terminated. It also mutated the caller's array. Both were caught by the byte-cap unit test.
- **WebSocket approval is implemented** as described: `ctx.ui.confirm` per call, refused with no UI
  unless `PI_MONITOR_ALLOW_WS=1`.
- **Print mode (`pi -p`) ends the session when the agent settles**, which stops the monitors. Only
  interactive sessions keep a watch alive across idle time. Documented in the README.
- **The ended notice uses the monitor's own `deliverAs`, not `followUp`.** With events on `steer` and
  the notice on `followUp`, an idle session delivered "ended" before the final event it summarised.
  Caught by testing the tool in a live interactive session.
