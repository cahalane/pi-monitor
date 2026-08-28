# pi-monitor

A [pi](https://pi.dev) extension that lets the model watch something in the background and have new
output delivered into the running session, instead of re-running a status command in a loop. It
ports the Monitor tool concept from Claude Code to pi.

## Attribution

This project is original work by Colm Cahalane. Its delivery-scheduler design was informed by
[pi-background-tasks](https://pi.dev/packages/pi-background-tasks), an ISC-licensed pi extension by
[Ismail](https://github.com/ismailsaleekh). This repository does not include source files from that
package; the upstream notice is preserved in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

The model calls `monitor` once. Each batch of new output then arrives on its own as a separate
message, and the model can start a turn to react to it. Nobody tails a log file or reruns
`gh pr checks` every thirty seconds to find out whether anything moved.

## Example

Ask pi to watch a build, and it makes one tool call:

```
monitor { name: "build", command: "./gradlew build --console=plain", match: "ERROR|BUILD" }
```

Output then arrives on its own, one message per batch:

```
monitor mon_1 "build" — line 1 (untrusted output)
| ERROR: unresolved reference: fooBar

monitor mon_1 "build" ended — command exited 1. 4 lines delivered, 310 B, over 47s.
The watch is finished; do not restart it just to confirm.
```

For CI status, use `poll` so unchanged output costs nothing:

```
monitor { name: "ci", poll: { command: "gh pr checks 4821", intervalMs: 30000 }, until: "fail|pass" }
```

## When to use it

Reach for `monitor` instead of `bg_run` + `bg_logs` when the model would otherwise poll: tailing a
build log, watching a long-running command, or checking CI/PR/deploy status on a timer. `bg_run`
still fits one-shot background commands whose completion the model finds out about once, through
the normal terminal notification. `monitor` fits anything the model would otherwise check
repeatedly.

Three sources:

- `command` — streams a long-running command's stdout/stderr lines as they arrive.
- `poll` — reruns a command on an interval and reports only when the output changes. This is the
  CI/PR/deploy case; a status table that prints unchanged every ten seconds produces no events
  until it moves.
- `ws` — connects to a WebSocket feed that already pushes events, rather than pulling them.

## Requirements

Node 22.6 or newer. The extension is TypeScript loaded through pi, and it uses node's built-in
`WebSocket`, so nothing needs compiling.

## Install

```
pi install git:github.com/cahalane/pi-monitor
```

That adds the package to `~/.pi/settings.json` and runs `npm install` for you, which pulls in
`undici`. Restart pi and the `monitor`, `monitor_list` and `monitor_stop` tools are available.

To hack on it instead, clone the repo and install from the path:

```
git clone git@github.com:cahalane/pi-monitor.git
cd pi-monitor && npm install
pi install ./
```

`undici` is only needed for WebSocket monitors, which use it to pin the connection to an
already-validated address (see Security). Without `undici` importable, `ws` monitors refuse to start
unless `PI_MONITOR_ALLOW_UNPINNED_WS=1` is set. `command` and `poll` monitors do not need it.

## Uninstall

```
pi remove git:github.com/cahalane/pi-monitor
```

## Tools

### `monitor`

Starts a watch and returns immediately with a monitor id (`mon_1`, `mon_2`, …), the resolved
source, and the caps in effect. Exactly one of `command`, `poll`, `ws` is required.

| Parameter | Type | Default | Notes |
|---|---|---|---|
| `name` | string | required | Short label, shown in event headers, the widget and `monitor_list`. |
| `command` | string | — | Long-running shell command; mutually exclusive with `poll` and `ws`. |
| `poll` | `{command, intervalMs?}` | — | Rerun `command` every `intervalMs` (min 1000 ms, default 15000 ms, max 3,600,000 ms) and emit only when the canonical output changes. |
| `ws` | `{url, protocols?}` | — | `ws://` or `wss://` only, no embedded credentials, no whitespace. |
| `cwd` | string | session cwd | `command` and `poll` only. |
| `timeoutMs` | number | 300000 | Watch ends at this deadline unless `persistent`. Clamped to 1000–86,400,000 ms. |
| `persistent` | boolean | false | Ignore the deadline; run until stopped or capped. |
| `match` | string (regex) | — | Only lines matching this become events. |
| `ignore` | string (regex) | — | Lines matching this are dropped, applied after `match`. |
| `until` | string (regex) | — | The watch ends once a line matches, after delivering that line. |
| `dedupe` | boolean | false | Drop a line identical to the immediately preceding accepted line. |
| `batchMs` | number | 400 | Coalesce lines arriving within this window into one interjection; 0 sends each line as it lands. Clamped to 0–60000 ms. |
| `maxEvents` | number | 100 | Stop the monitor after this many delivered lines. Clamped to 1–1000. |
| `wake` | boolean | true | Start a turn (`triggerTurn`) when output arrives and the agent is idle. `false` means the output waits for the next reply anyway. |
| `deliverAs` | `steer` \| `followUp` \| `nextTurn` | `steer` | Escape hatch for a monitor whose output should not interrupt the current line of work. |

Command monitors run under `/bin/sh -c` (or `cmd.exe /c` on Windows) in their own process group.
Poll monitors run the same way, once per interval, hashing the trimmed, newline-normalised output
to detect change.

### `monitor_list`

No parameters. Returns every monitor in the session — live and recently ended — with id, name,
source, status, events delivered, bytes injected, uptime, last-event age, buffered-but-undelivered
line count, and end reason if ended. Also reports the session-wide injected-byte budget used out of
262144 bytes (256 KiB). Cheap to call; the footer widget is the primary display while something is
running.

### `monitor_stop`

One parameter, `id` — a monitor id or `"all"`. Stops the source (kills the process group, or
closes the socket) and returns the final counts. Does not send a model-facing terminal notice for a
tool-initiated stop; the tool's own return value is the notice.

### `/monitor` command

`/monitor list` (or bare `/monitor`) prints the same snapshot as `monitor_list`. `/monitor stop
<id|all>` stops one or all monitors. Both are host UI notifications, not tokens spent by the model.

### Footer status and widget

While at least one monitor is live, the status line shows `◉ N watching` (with a `(waking
suspended)` suffix when the consecutive-wake cap has fired), and a widget lists each live monitor
with its event count and last-event age. Both clear when no monitor is live.

## Delivery semantics

pi's `pi.sendMessage` has three delivery modes, and monitor uses all of them precisely:

- `steer` delivers after the current assistant turn finishes all of its tool calls, immediately
  before the next LLM call. It does not interrupt a running tool call — pi has no mechanism for
  that.
- `followUp` waits until the agent has no tool calls left at all before delivering.
- `triggerTurn: true` starts a new turn only when the agent is idle; it never creates a concurrent
  turn alongside one already running.

Monitor events and the terminal "monitor ended" notice both use the monitor's own `deliverAs`
(default `steer`). They share one queue deliberately: sending the notice as `followUp` while events
went out as `steer` let an idle session show "ended" before the last event it summarised.

### Scheduler rules

- One undelivered notification per monitor. Once a monitor's batch is sent, further lines coalesce
  in its buffer rather than triggering a second send. The buffer is released once `turn_end` or
  `agent_settled` fires, which is pi's signal that the previous notification has been consumed.
- One automatic wake outstanding across the whole registry at a time. A second monitor's output
  arriving while a wake is already pending is sent without `triggerTurn` (it will be picked up
  anyway) rather than queuing a second wake.
- A minimum wake interval of 5000 ms. If a monitor's batch is ready before 5 s have passed since
  the last wake, the flush is deferred rather than sent — sending it immediately would queue a
  message with nothing scheduled to read it.
- A cap of 8 consecutive monitor-triggered turns. Hitting it suspends waking: monitors keep
  collecting and their output still arrives, but nothing starts a turn until the user sends a
  message (`before_agent_start`), which resets the counter and lifts the suspension. The model is
  told this once, via a `followUp` notice with `triggerTurn: false`.

## Caps and budgets

| Budget | Value | Effect when hit |
|---|---|---|
| Live monitors per session | 8 | `monitor` rejects a new watch until one is stopped. |
| Events per monitor | 100 (or `maxEvents`) | The monitor auto-stops with a `cap` end reason. |
| Injected bytes per monitor | 64 KiB | Same: auto-stop, `cap` end reason. |
| Injected bytes per session | 256 KiB | Every live monitor is stopped with a `cap` end reason citing the session budget. |
| Buffered-but-undelivered bytes, all monitors | 64 KiB | Oldest lines are dropped from the biggest buffers first; the drop count surfaces as "N dropped" in the next event header. |
| Lines per flush | 20 (ceiling 50) | Extra lines are elided from the middle of the batch with a `… N lines elided …` marker. |
| Bytes per flush | 8 KiB | Lines are dropped from the middle (recomputing the elision marker) until the batch fits, or hard-truncated as a last resort. |
| Line length | 2000 characters | The line's head is elided, keeping the tail, since new output is usually at the end. |
| Poll command output captured per tick | 64 KiB | Extra output is discarded before hashing/diffing. |
| WebSocket message size | 1 MiB | The message is dropped and the watch ends with an `error` reason. |

A monitor that hits `maxEvents` or its byte cap does not just stop quietly: it sends the same
`monitor-ended` notice as any other end reason, so the model does not need to poll to find out.

## Limitations

- Monitors are session-scoped. `/new`, `/resume`, `/fork` and quitting all stop every monitor;
  nothing resumes across sessions, and `monitor_list` after `/resume` is empty.
- Print mode (`pi -p`) exits as soon as the agent settles, which stops the monitors with it. A watch
  whose first event is seconds away will not survive; monitors are for interactive sessions.
- There is no mid-tool-call interrupt in pi. A monitor's output cannot land while a tool the model
  called is still running; it waits for that tool call to finish.
- Process-group kill (`SIGTERM` then `SIGKILL` after 3 s) is POSIX only. On Windows, stop calls
  `child.kill()` on the shell process itself and is best effort — a pipeline's children may
  outlive it.
- A WebSocket message over 1 MiB ends the watch rather than truncating it. Subscribe to a filtered
  feed instead of a firehose.
- A binary WebSocket frame is never decoded; it becomes a `[binary frame, N bytes]` placeholder
  line.

## Security

Every event and terminal notice tells the model the payload is untrusted output and not to follow
instructions found in it. Each line is also prefixed with `| ` in the rendered payload, so nothing
in a watched stream can forge a header or close the block early.

WebSocket monitors are the SSRF-sensitive path. `ws://`/`wss://` targets are validated (scheme,
ASCII only, no embedded credentials, valid subprotocol tokens), the hostname is resolved once, and
every resolved address is checked against loopback, private (10/8, 172.16/12, 192.168/16),
link-local (169.254/16, which covers cloud metadata endpoints), CGNAT (100.64/10), and the IPv6
equivalents. The connection is then made through an `undici` dispatcher whose `lookup` returns only
that already-validated address — TLS still verifies and SNIs on the real hostname, but the connect
step cannot re-resolve to a different, private address after the check passed. Without `undici` importable, `ws` monitors refuse to start unless `PI_MONITOR_ALLOW_UNPINNED_WS=1` is set, which
accepts the re-resolution risk explicitly.

Opening a WebSocket also asks the user first: `monitor` calls `ctx.ui.confirm` with the target URL
once per call, and refuses the connection if the answer is no. With no UI attached there is nobody
to ask, so `ws` monitors fail unless `PI_MONITOR_ALLOW_WS=1` is set. There is no per-host "always
allow".

Command and poll monitors are not sandboxed and are not gated by any confirmation prompt: calling
`monitor` with a `command` runs it exactly as `bash`/`bg_run` would. Enabling this extension adds a
second arbitrary-command execution path that does not go through Bash's own allow/deny policy.
Pre-tool hooks still see the `monitor` tool call and can block it there, but there is no
extension-level confirmation step in front of it.

## Tests

```
npm test
```

43 tests over line filtering and batching, WebSocket address validation, event and notice
rendering, and the delivery scheduler. They run in about 0.15 s and spawn no process and open no
socket: the scheduler tests drive a fake clock and a fake source through the registry's injectable
hooks.

Four of the bugs these tests and the live smoke runs caught are recorded in
[`docs/design.md`](docs/design.md), along with why the scheduler defers a flush rather than sending
output nothing is scheduled to read.
