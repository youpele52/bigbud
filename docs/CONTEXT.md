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
