# bigbud Product Distribution

This context defines how bigbud identifies development, stable, and prerelease builds to users.

## Language

**Build Mode**:
The execution context that distinguishes a local development build from a packaged build.
_Avoid_: Release channel, product stage

**Release Channel**:
An approved user-visible distribution channel derived from the first prerelease token in a packaged version; currently Beta, Preview, or Nightly.
_Avoid_: Build mode, product stage

**Stable Release**:
A packaged release whose version has no prerelease suffix and whose product identity is plain `bigbud`.

**Prerelease**:
A packaged release whose version contains a channel suffix such as `beta`, `preview`, or `nightly`.
_Avoid_: Beta when referring to prereleases generally

## Relationships

- A development **Build Mode** uses the `Dev` identity independently of any **Release Channel**.
- A **Stable Release** has no **Release Channel** badge.
- A **Prerelease** derives its **Release Channel** from its version: `v0.1.642-beta-2` belongs to the `Beta` channel.
- A public **Prerelease** with an unapproved channel token is invalid rather than stable-looking or automatically branded.
- The app's browser UI does not show the sidebar channel badge; that badge belongs to the installed Electron experience.
- Release artifact names use the complete version as their only channel marker, so stable artifacts remain unbadged while prerelease artifacts retain their channel suffix.
- Marketing presents the latest approved **Prerelease** with wording derived from its **Release Channel**, such as "Download beta" for a `beta` version.
- Desktop updates remain on the stable update track regardless of the installed **Release Channel**.
- Stable and prerelease channels are distributions of one application and share its bundle identity, protocol ownership, and packaged user data.

## Example dialogue

> **Dev:** "Can a build tagged `v0.1.642-beta-2` display Preview?"
> **Domain expert:** "No. Its **Release Channel** is Beta because the version says `beta`; use a `preview` prerelease token for Preview."

## Flagged ambiguities

- "Production" previously meant any packaged build and a stable release. Resolved: use **Stable Release** when specifically referring to an unbadged packaged release.

# Desktop Orchestration Delivery

This context distinguishes canonical product ownership from reliable delivery
coordination in the packaged desktop runtime.

## Language

**Canonical Domain Authority**:
The TypeScript server and SQLite state that define which orchestration events
exist, their canonical order, replay data, authorization, and product meaning.
_Avoid_: Supervisor, delivery authority

**Desktop Delivery Supervisor**:
The packaged `bigbud-desktop-supervisor` Rust sidecar that authoritatively
coordinates bounded orchestration-event delivery for an attached desktop
consumer. It owns batching, delivery ordering, consumer generations,
application acknowledgements, timeouts, and reconnect recovery, but does not
create or interpret orchestration events.
_Avoid_: Application server, canonical event store

**Delivery Authority**:
The single active path allowed to deliver canonical orchestration events to a
consumer. For a supervisor-managed packaged desktop session, the **Desktop
Delivery Supervisor** is the delivery authority and events must not bypass it.

**Application Acknowledgement**:
The web consumer's confirmation that it has serially applied a complete batch
and finished canonical ownership reconciliation. A WebSocket write or receipt
alone is not an application acknowledgement.

**Controlled Fallback**:
An emergency, fenced transition from a failed supervisor-managed session to
the TypeScript delivery path after bounded restart, reconnect, and replay
recovery are exhausted. It resumes after the last verified application
acknowledgement, stays on TypeScript for the rest of that session, and never
causes the two paths to deliver concurrently.

**Direct Unmanaged Delivery**:
The retained TypeScript delivery route for standalone server and mobile-remote
consumers that do not have a supported native supervisor distribution. It is
not evidence that a packaged desktop supervisor failed.

## Operations

Packaged Electron passes the immutable supervisor path in
`BIGBUD_DESKTOP_SUPERVISOR_BINARY` and marks packaged intent with
`BIGBUD_DESKTOP_PACKAGED=1`. Development can opt in with
`BIGBUD_DESKTOP_SUPERVISOR_ENABLED=1`; setting it to `0` is the startup-only
rollback gate. A missing or incompatible packaged binary produces factual
`degraded` and `fallback` lifecycle states. Fallback is terminal for that
subscription; reconnect or reload creates a new subscription decision.

## Relationships

- The **Canonical Domain Authority** supplies events to the **Delivery Authority**.
- The **Desktop Delivery Supervisor** is authoritative for delivery, not domain truth.
- A supervisor restart preserves authority when the server can reattach and recover from the last **Application Acknowledgement**.
- **Controlled Fallback** is a terminal recovery mode for the current session, not normal routing or a mid-session switchback mechanism.
