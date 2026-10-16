# OpenCode V2 native subagents: gate G4 evidence (2026-10-16)

Plan: [Claude Agent SDK and subagent display](../plans/2026-10-16-claude-agent-sdk-and-subagent-display-plan.md), Phase 4. Decision D1: enable V2 native subagents only when gate G4 passes, with automated evidence that children inherit the parent's permissions.

## Outcome: G4 not passed. Native subagents stay denied.

The `subagent` rule stays `deny` in `v2SharedToolPolicy` (`apps/server/src/provider/Layers/OpencodeV2/Runtime.policy.shared.ts`) and `v2LocalToolPolicy` (`Runtime.policy.ts`). The read-only observer ships, but stays inert: while the policy denies the tool, no child session exists, so V2 shows no subagents and nothing is fabricated.

## Why G4 cannot be proven by automated tests

Every G4 item needs frames recorded from a real native probe. A probe requires a live model run in an isolated profile with `subagent` allowed. That run calls a paid provider, and this delivery forbids paid live runs (D2). No recorded child frames exist in the repository: `SharedService.official.ndjson` and `NativeCompatibility.official.ndjson` contain no `session.created` event at all (`parentID` appears only in the recorded OpenAPI text, as a `session.list` filter and as the create-session parameter that "creates a linked child session at its parent's location"), and the pinned 2.0.26 client declarations do not state the child's effective permissions.

| Item                        | What it needs                                                                                                                                    | Status                                                                                                                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| G4.1 parent linkage         | A recorded `session.created.parentID` and `SessionInfo.parentID` from a real `subagent` call                                                     | Not proven. The 2.0.26 types declare both fields; no recorded frame.                                                                                                                 |
| G4.2 permission inheritance | The child's effective `SessionInfo.permissions` for each runtime mode, and denied/ask outcomes for protected-path edits and `external_directory` | Not proven. The types make `permissions` optional and say nothing about inheritance. This is the safety-critical item.                                                               |
| G4.3 request routing        | Child permission and question requests reaching the parent's owner                                                                               | Not proven. EventHub drops child events by design; routing would need new code and recorded frames.                                                                                  |
| G4.4 interrupt propagation  | Parent interrupt stopping the child, or a bounded child terminal signal                                                                          | Not proven.                                                                                                                                                                          |
| G4.5 observer fidelity      | Observer mapping matching a probe child, with no child mutation                                                                                  | Partly: `Runtime.subagents.test.ts` proves the mapping and the read-only behavior against synthetic `SessionInfo` shapes from the 2.0.26 types. Matching a real probe is not proven. |

## What is tested now

- `Runtime.subagents.test.ts`:
  - an active child maps to a `providerSubagent` task (`opencodeV2:{threadId}:{epoch}:{childId}`, model `{providerID}/{id}`, tokens and cost, created time);
  - outcomes map to completed, failed and stopped, with end time and duration;
  - a failed read demotes known children to "last seen" and never fails the parent turn;
  - forks and unrelated sessions are never subagents; the child is never read or written directly;
  - observer events carry no top-level `turnId`, so they are never turn liveness evidence;
  - the observer stays inert without a subagent call, a child hint, or a live child;
  - an EventHub child hint refreshes the observer through the coalesced repair queue;
  - the `subagent` action is denied in every runtime mode, for both shared and local policies.
- `EventHub.children.test.ts`: child hints from `session.created.parentID` and observer reads, at most 32 children per owner, unknown IDs still dropped, owners never receive child events, deltas never hint.

## Re-run

Re-run G4 on each V2 runtime upgrade, and when a recorded native probe becomes available. Enabling requires changing the `subagent` rule per mode and deliberately updating `Runtime.policy.test.ts`, `Runtime.accessModes.test.ts`, `Runtime.policy.shared.paths.test.ts`, `SharedService.legacy.fixture.ts` and `Runtime.subagents.test.ts`.
