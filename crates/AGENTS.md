# Rust Workspace Instructions

These instructions apply to every current and future crate under `crates/`. They supplement the [repository-root `AGENTS.md`](../AGENTS.md); do not repeat or weaken root rules.

## Developer Commands

```sh
cargo fmt --all --check
cargo clippy --locked --workspace --all-targets -- -D warnings
cargo test --locked --workspace
```

## Architectural authority

This Rust workspace is mainly for core, close-to-the-metal services, consistent with [how it started](../docs/decisions/2026-08-22-rust-remote-workspace-agent-boundary.md).

- Rust native components are provider-neutral systems backends. They may perform
  explicitly authorized filesystem, search, Git, process, PTY, watch, IPC, and
  platform operations, but must not interpret provider protocols or become an
  independent source of bigbud domain truth.
- A native supervisor may own bounded child-process lifecycle, IPC transport,
  native resource monitoring, and crash containment when those responsibilities
  require native reliability or performance. It must expose a narrow,
  versioned contract to the TypeScript/Electron owner.
- Behavior must remain predictable during load, process restarts, reconnects,
  partial frames or streams, duplicate delivery, and ambiguous failures.

## Workspace and crate organization

- Put all first-party Rust crates under `crates/` and add each crate explicitly
  to the root Cargo workspace.
- Name first-party packages `bigbud-<concise-role>` using lowercase kebab case.
  Rust library crate identifiers may use Cargo's corresponding underscore form.
- Inherit `edition`, `rust-version`, `license`, and version from
  `[workspace.package]`. Put dependencies used by multiple crates in
  `[workspace.dependencies]`.
- Create a new crate only when it establishes a real dependency, deployment, or
  platform boundary: an independently packaged binary, a reusable library with
  more than one credible consumer, generated protocol ownership, or isolation
  needed to prevent dependency inversion. Otherwise extend and split the
  existing owning crate.
- Do not create catch-all `common`, `core`, or `utils` crates. Extract shared
  code around a named capability and keep its public API smaller than its
  implementation.
- Keep dependency direction acyclic and capability-oriented. Protocol and
  reusable systems libraries must not depend on executable/supervisor crates or
  TypeScript/Electron implementation details.
- A binary crate should keep `main.rs` limited to configuration, composition,
  startup, exit-code mapping, and top-level shutdown. Put testable behavior in
  its library or focused modules.
- Libraries must not start threads, subprocesses, listeners, watchers, or async
  runtimes merely by being imported or constructed unless that lifecycle is the
  documented purpose of the constructor and is explicitly stoppable.

## Error handling and return values

- Production code must use explicit `Result` and `Option` handling. Propagate
  failures with `?` and typed errors, add meaningful context, and use deliberate
  `match` branches when different cases require different behavior.
- Use `anyhow` at application or executable boundaries when attaching context
  and selecting an exit behavior; keep reusable library errors typed and
  inspectable.
- Use `unwrap` and `unwrap_or` only when necessary. In non-test code, require a
  demonstrated invariant or an explicitly safe fallback, and document why the
  condition cannot fail or why the fallback is correct.
- Never use `unwrap` or `unwrap_or` to hide failures from I/O, filesystem,
  protocol, subprocess, IPC, concurrency, or user-controlled input.
- Always consume meaningful return values. Do not silently discard a `Result`,
  `Option`, status, acknowledgement, or other return value. If a value is
  intentionally discarded, make that choice explicit and ensure it cannot
  weaken correctness, recovery, or safety guarantees.

## Lifecycle and backpressure

- Every thread, task, watcher, subprocess, PTY, and IPC connection must have a
  clear owner, explicit cancellation path, and bounded shutdown or join path.
- Use bounded queues and retained state. Define capacity, overflow behavior,
  slow-consumer handling, and recovery semantics; never hide overload with
  unbounded buffering.
- A transport interruption is not cancellation. Do not retry accepted,
  non-idempotent work unless operation identity and deduplication make replay
  safe. Give connection, execution, cancellation, and shutdown separate
  timeouts where their failure semantics differ.
- Shutdown must stop new work, signal cancellation, settle accepted work
  according to its contract, close transports, terminate owned children, and
  join workers without leaking resources.

## Protocol invariants

- Protocol changes must update the owning `.proto` files, Rust implementation,
  TypeScript codec, and shared golden or compatibility tests together.
- Validate frame lengths before allocation and reject oversized, truncated,
  malformed, empty, or incompatible frames without panicking. Negotiate
  protocol versions, capabilities, and limits before accepting operations.
- Preserve field numbers and enum values once released; never reuse removed
  values. Use major versions for incompatible changes and minor versions for
  backward-compatible additions.
- Operation identities and request digests must make duplicate acceptance
  deterministic. Sequence numbers are monotonic per stream and epoch;
  acknowledgements cannot move backward or beyond produced output. Report an
  explicit replay gap or expiry when the retained suffix is unavailable.
- Treat watch events as invalidations, not canonical state. Overflow, sequence
  gaps, backend replacement, and reconnects must require an explicit rescan.

## Cross-platform and security

- Consider macOS, Windows, and Linux for every filesystem, path, process, PTY,
  IPC, permission, signal, watcher, and packaging change. Isolate platform code
  behind small `cfg`-gated modules with a common tested interface.
- Validate workspace-relative paths at the final filesystem operation. Reject
  NUL bytes, absolute paths, traversal, symlink escapes, Windows prefixes, and
  junction or reparse-point escapes as applicable.
- Treat protocol input, filesystem contents, environment variables, subprocess
  output, and remote responses as untrusted. Do not disable host-key checking,
  forward provider credentials, or add network authority without review.
- Safe Rust is the default. Every `unsafe` block requires an adjacent
  `// SAFETY:` comment explaining its invariants and a focused review and test.
- Do not log credentials, tokens, environment secrets, file contents, command
  input/output, or unnecessarily precise sensitive paths.

## Packaging and release boundary

- Build and package the platform-native `bigbud-remote-agent` executable for
  the target OS and architecture. Preserve Unix executable permissions and the
  Windows `.exe` convention.
- Keep binary identity, handshake fields, protocol versions, staged paths, and
  launch behavior synchronized with the desktop and release scripts. Verify
  the packaged binary before use.
- Rust work owns reproducible builds, target correctness, runtime behavior, and
  package-boundary smoke tests. Signing, notarization, updater publication,
  and broad release certification remain release-management concerns unless
  explicitly included in the task.

## Testing and performance

- Put deterministic logic tests beside the owning module. Use `tests/` for
  public-API, real-process, packaging-boundary, or cross-crate integration tests.
- Every bug fix requires a regression test that fails for the original defect.

## Dependencies and features

- Prefer the standard library and existing workspace dependencies. Add a crate
  only when it materially reduces correctness risk or supplies a maintained,
  well-defined platform capability.
- Before adding a dependency, inspect maintenance status, license, transitive
  dependency cost, unsafe surface, default features, supported targets, and
  binary-size/build-time impact. Then inform the engineering team about your finding and get approval before adding it to the workspace.
- Features must be additive and must not silently change protocol or persistence
  semantics. Test every feature combination shipped by bigbud.
- Do not patch or fork dependencies without documenting the reason, upstream
  status, ownership, and removal condition.

## Modules and generated code

- Every authored source and test file must remain at or below the root
  400-line hard limit. Split existing oversized files before materially editing
  them.
- Organize related implementation by capability folders under `src/`. Prefer
  `capability/mod.rs` as a very lean module root containing declarations,
  visibility, and re-exports only; put implementation in sibling files or
  deeper capability folders.
- Keep a single focused module as `src/<name>.rs`; use a capability folder when
  the module has multiple implementation or test files.
- Do not leave large collections of capability files at the `src/` root. Move
  cohesive code such as process, PTY, supervisor, session, workspace, and
  journal concerns into their own directories.
- Dotted filenames are allowed, especially when splitting a long file into
  multiple focused implementation or test files. Choose dotted filenames or
  nested folders based on clarity and ownership; neither structure is
  prohibited.
- Keep `lib.rs`, `main.rs`, and each `mod.rs` focused on composition, public
  API, and invariants rather than implementation dumps.
- Never hand-edit generated Rust or generated protocol artifacts. Change the
  owning schema or generator and regenerate.
- `protocol/remote-agent/*.proto` is the source of truth for the remote-agent
  wire schema. `bigbud-protocol/build.rs` owns Rust generation.
- Generators must be deterministic, declare all relevant Cargo rerun inputs,
  avoid network access during builds, and pin generator/tool dependencies where
  reproducibility requires it.
- When generated output risks exceeding 400 lines, split it at the schema or
  generator boundary rather than post-processing generated files manually.
