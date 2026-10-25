# Durable agents: OpenCode, Pi, and a Rust socket layer

Research date: 2026-10-21. No code was changed. Baselines and citations are in the linked notes.

## Answer

Make the agent durable in the process that owns the work. Do not build a Rust process whose job is to keep the renderer's WebSocket open.

OpenCode already did the first thing. In `opencode serve --service`, the prompt is saved before the turn runs, a claim is saved when the turn starts, and a crash or restart resumes the turn by asking the model to continue, up to ten times. The event stream the UI watches is live-only and is not what keeps the agent alive. bigbud's OpenCode V2 integration uses that daemon, so those turns already survive a bigbud backend crash. Detail: [opencode.md](opencode.md).

Pi did the first thing in a different package, and bigbud does not run that package. The [Pi Durable post](https://earendil.com/posts/pi-durable/) (1 October 2026) describes an experimental harness, `@earendil-works/pi-durable`: every model call and tool call is a checkpointed task, a tool reruns after a crash only if it declares that safe, and a new process continues by opening the same storage. The post is explicit that this does not replace the Pi coding agent. The coding agent bigbud launches still writes finished messages to a JSONL file and aborts the turn when its stdin closes, which is what happens when the bigbud server dies. Detail: [pi.md](pi.md).

bigbud's own UI connection is already stronger than either shipping client: orchestration events resume from the last applied sequence. The gap is the agent, and it is largest for Pi. Side by side: [comparison.md](comparison.md).

## Recommendation

**Do not build the Rust socket layer.** Confidence: high.

A Rust process that holds the renderer's socket would hide some restarts and would answer pings while the TypeScript server is frozen. It would not checkpoint a turn, and it would not keep Pi alive, because Pi dies when the server's stdin pipe closes. The freezes that caused most drops on 21 October 2026 are removed by getting synchronous SQLite and SSH off the server's main thread, which is already underway. The durable-agent work is the existing auto-resume plan plus connection-resilience Phase 6: remember the attempt before calling the provider, continue only when that is safe, and ask when a tool may have been mid-flight.

Take three things from Pi Durable and OpenCode, all inside those plans: a short allowlist of read-only tools that may rerun, a parked state after repeated crashes, and a process owner that can keep Pi's stdin open across a backend restart. That owner is the Rust background-service plan, not a socket proxy. Leave D7 deferred. Detail: [lessons.md](lessons.md), [rust-durable-layer.md](rust-durable-layer.md).

## Open questions

1. After a crash, may a read-only tool such as file read or search run again on its own, or should every in-flight tool wait for you? Pi Durable reruns the ones marked safe. The current bigbud plan asks you every time.
2. Should a running Pi turn survive a bigbud backend restart? That requires some process to keep Pi's stdin open. It is a yes or no for the background-service plan, and a socket layer does not provide it.
3. Is the Pi coding-agent CLI the permanent integration, or is embedding Pi Durable in scope later for Pi only? As of Pi 1.3.0 the CLI does not use that harness, and the post says the CLI is not being replaced.
4. For sleep, the recoverable goal is "continue after the lid opens." None of these systems keep local work running while the machine is asleep. Remote SSH work can keep running and needs reattachment, which Phase 6 already says.
