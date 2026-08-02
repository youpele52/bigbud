# Provider Log Retention Plan for v0.1.647

Related release note: [v0.1.647 note](/Users/youpele/.bigbud/userdata/notes/1c4f7525-6e2b-4c23-b079-4052a36d0f4c/v0.1.647.md)

## Status

Proposed.

## Summary

The current provider event logs under `~/.bigbud/{userdata,dev}/logs/provider/` are too verbose and have no retention policy, which allows disk usage to grow without bound. The fix should do two things together:

1. Restrict verbose provider event logging to development only.
2. Automatically delete provider log files older than 7 days.

This keeps deep diagnostic tracing available in development while preventing production installs from accumulating large, low-value provider trace logs indefinitely.

## Problem Statement

Current behavior:

1. Provider logs capture highly verbose raw event streams, including per-character or per-delta payloads.
2. These logs are written under both `~/.bigbud/userdata/logs/provider/` and `~/.bigbud/dev/logs/provider/`.
3. There is currently no automatic cleanup or age-based pruning.
4. Production users therefore accumulate large amounts of provider trace data over time.

Operational result:

1. Disk growth is unbounded.
2. Most of the stored payload is only useful for deep debugging.
3. Logs are effectively acting as accidental long-term history storage, which is not an appropriate role for trace logs.

## Goals

1. Prevent unbounded provider log growth in normal user installs.
2. Keep verbose provider tracing available for development/debugging.
3. Preserve essential production logging for support and operational visibility.
4. Automatically prune provider logs older than 7 days.
5. Apply the same cleanup behavior to both `userdata` and `dev` provider log directories.

## Non-Goals

This change should not:

1. Treat provider logs as a durable conversation history mechanism.
2. Keep raw per-delta provider traces in production by default.
3. Require users to manually clear provider logs to control disk growth.
4. Introduce a complicated retention policy for v1 of this fix.

## Product Decisions

### 1. Verbose provider logging is development-only

The current raw provider event logging should be available only in development.

Development behavior:

1. Keep verbose provider event logging available for debugging.
2. Preserve the ability to inspect raw stream/provider behavior when diagnosing issues.

Production behavior:

1. Do not write the current verbose per-event/per-delta provider trace logs.
2. Keep only minimal operational logging needed for reliability and support.

### 2. Production logging should be minimal and useful

Production provider logs should keep only high-value signals such as:

1. Errors
2. Warnings
3. Important provider/session lifecycle events
4. Other operational events required to diagnose failures without storing full raw trace payloads

The key requirement is that production logging remains useful without producing large raw trace files.

### 3. Automatic log cleanup uses a 7-day retention window

Provider log files older than 7 days should be deleted automatically.

Retention policy:

1. Applies to files in `~/.bigbud/userdata/logs/provider/`
2. Applies to files in `~/.bigbud/dev/logs/provider/`
3. Deletes any provider log file whose age is greater than 7 days

### 4. Cleanup runs automatically

Minimum required cleanup timing:

1. Run provider log cleanup automatically on app/server startup.

Optional follow-up behavior:

1. Add a periodic cleanup timer while the app is running if needed.

Startup cleanup is the baseline because it guarantees old logs are pruned even for long-idle installs.

## Implementation Direction

### 1. Separate development trace logging from production operational logging

The provider logging path should clearly distinguish:

1. Development-only verbose trace logs
2. Production-safe minimal provider logs

This should be handled by runtime environment gating rather than by relying on users to toggle logging manually.

### 2. Add a provider-log cleanup pass

On startup, scan the provider log directories for both runtime profiles and remove files older than 7 days.

Important implementation intent:

1. Cleanup should be best-effort and safe.
2. Missing directories should not be treated as errors.
3. Cleanup failures should not block app startup.
4. Cleanup activity should be observable enough to diagnose failures if pruning stops working.

### 3. Keep logs disposable

Provider logs should be treated as disposable diagnostics, not as the canonical record of conversation history or tool execution history.

That design principle matters because retention can then stay aggressive without creating product ambiguity.

## Rollout Expectations

After this change:

1. Development still has access to verbose provider traces when debugging.
2. Production no longer emits the current raw verbose provider traces by default.
3. Old provider logs are pruned automatically after 7 days.
4. Disk usage in `~/.bigbud` should stop growing without bound from provider logs alone.

## Recommendation

Implement the fix exactly as this combined policy:

1. Verbose provider event logging: development only
2. Production provider logging: minimal and operational
3. Provider log retention: automatically delete files older than 7 days

This is the simplest plan that addresses both the future-growth problem and the existing stale-log accumulation problem.
