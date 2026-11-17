# Mobile orphan runtime-asset repair (2026-11-17)

Increment 7 item from
[the native mobile composition plan](../plans/2026-11-17-production-native-mobile-composition-plan.md)
(Risks: runtime asset trees left after a successor exit). Uncommitted; verified only on macOS with
temporary trees. It has not run on Linux or in a VM yet.

## What it does

A conservative GC over `<stateDir>/remote-mobile-runtime-v1/`. A generation (`assets-<hex>` and its
`.receipt.json`) is removed only when all of these hold:

- Exactly one journal attempt records this generation in `nativeOwnership.assetsReference`, and that
  attempt is `exit-confirmed`.
- The attempt's base pin (`mobileGatewayBuildPin(nonce)`) is gone.
- The attempt's stage is not active. A stage is active while an unresolved attempt or an in-flight
  publication (`reserved`, `artifact-bytes-verified`, `publication-writing`) is on it. An original
  token in this process must not hold the path either.
- The receipt's bytes match the journal reference hash exactly and re-encode canonically. The
  receipt also names the same nonce, stage, release, consent revision, owner pin and controller
  (and host).
- The state, namespace and root directories still have the dev, inode, uid, gid and mode recorded
  in the receipt. Every tree member matches its receipt entry, and no members were added.

Removal uses the normal cleanup's `removeMobileRuntimeInventory` and the shared receipt unlink. The
GC never follows links. Anything uncertain is kept and reported with a fixed reason code.

## When it runs

- Once on controller attach, after `resume()`. Like the rest, it is off without proof inputs.
- On demand: `bigbud mobile repair --authority <id> [--json]` goes through the owner route
  (bearer token and authority check). With no controller attached, the route refuses with
  `unavailable`.
- `bigbud mobile status` shows `Last asset repair: N removed, M kept at <time>` (or `failed`).

## Things to know

- The rule for the active stage is my reading of the brief. The `desired` selection alone does not
  keep a tree, because every launch extracts a fresh generation. Say if you want the desired stage
  kept as well.
- Trees with no journal attempt are kept as `no-journal-attempt`. This covers a failure after
  extraction but before reservation. They need manual review. The 64-generation preparation cap
  still applies to them.
- A removal that fails partway leaves a partial tree. Later runs report it as `tree-changed`
  forever, so it needs a manual look.
- Still to do in increment 7: run the GC as part of the Linux live acceptance after a
  `kill -9` successor exit.
