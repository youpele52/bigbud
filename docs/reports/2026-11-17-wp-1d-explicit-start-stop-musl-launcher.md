# WP-1D: explicit backend start/stop and musl launcher on a gnu graph

**Date:** 17 November 2026
**Plan:** [Remote completion plan](../plans/2026-11-17-remote-completion-plan.md), WP-1D (D8, D3)
**State:** Implemented, uncommitted. Unit-tested only; no live systemd run yet.

## What changed

- `bigbud backend start --authority <id>` and `bigbud backend stop --authority <id>`
  (TypeScript CLI) call the native `--backend-service start|stop <config>`. Neither enables,
  disables or reads/changes lingering.
- **Start** refuses when the units are not staged ("account units are not staged; run backend
  setup first"), when no working user manager exists, when artifact pins or the
  `--check --capabilities` identity fail, or when the loaded unit fragment is not bigbud's. It
  reloads the user manager and starts **only the backend unit**. It succeeds only if the backend is
  then `Starting` or `Active`.
- **Stop** stops both units in one job (backend first, then Rust). A changed artifact does not
  block stop. It succeeds only if both units are then inactive. Config, token, backend data, Rust
  state and unit files are kept.
- Both print the observed state of each unit. With lingering absent they also print the existing
  lingering remediation. `--confirm-startup` is refused for start/stop, because that flag means
  boot-startup consent.
- Setup now states the D3 rule explicitly: a gnu backend graph accepts the static musl Rust
  launcher (or a gnu one) for the host's architecture, and refuses a musl host (the backend tier is
  glibc-only; the Rust-only tier remains). Signature, byte hash and `--check` identity checks are
  unchanged.

## Deviation from the brief: start does not start the Rust unit directly

The brief said start should run `systemctl --user start` on both units. That is unsafe. The
Rust unit runs against the P4 launch reservation recorded in the config (attempt, boot ID, and no
`launch.exit`). After any earlier run or a reboot, that reservation is stale. A direct start
fails, and each failure counts toward the unit's crash limit. The backend's own startup
reconciliation writes a fresh reservation and then starts the Rust unit through `start-rust`
(`localSupervisorService.launch.ts`). So `backend start` starts the backend, and the backend
starts Rust. If you want a different rule, say so.

## Before release

- The musl-acceptance test passes against the old code too. Nothing on this setup path refused
  musl before, because the installer already prefers musl. The change adds the explicit rule and
  two new refusals: a musl host and an artifact for the wrong architecture.
- Explicit start without lingering only lasts while the account has a session. Starting is not
  backend readiness.

## Live systemd checklist (needs a real user manager, after M1)

1. With boot startup disabled: `backend start`. Check that `systemctl --user is-enabled` for the
   backend unit stays `disabled`, `loginctl show-user $UID -p Linger` is unchanged, and both units
   become active (Rust started by the backend).
2. `backend status`: both units show active, with crash-restarts 0.
3. `backend stop`: both units become inactive, the Rust terminals end, and the data and config
   directories are unchanged. Run `backend start` again and check it recovers.
4. Start on a host without lingering: it works, prints the lingering remediation, and the units
   stop at logout.
5. Before setup (or with unit files removed): start and stop both refuse with "not staged".
6. Edit one unit file: start refuses (units differ). Stop also refuses. Repair explicitly.
7. Run start/stop with boot startup enabled: `is-enabled` stays `enabled`.
8. On a glibc x86_64 and aarch64 host, run setup with a musl-only Rust manifest: setup succeeds
   and the registry runtime triple ends in `-musl`.
