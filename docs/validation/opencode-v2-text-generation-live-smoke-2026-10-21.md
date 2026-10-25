# OpenCode v2 Text Generation: Live Smoke Check

Date: 2026-10-21

## Scope

The user explicitly authorized controlled native generation after implementation review. This smoke check exercised all six methods of `OpencodeV2TextGenerationLive` against the existing shared native service. It did not run the repository's isolated native qualification suite or certify the desktop UI, other models, platforms, permission ceilings, or session-recovery contracts.

Baseline: HEAD `727394ee9984` plus the uncommitted text-generation implementation and concurrent work. Runtime: Bun `1.3.14` on macOS; installed `@opencode/client` `2.0.26`; native service `2.1.1`. This is source-level execution, not a released desktop-build qualification.

## Execution

- Read-only authenticated probes verified the service registration, `/api/info`, and the live `/openapi.json`. The production auxiliary contract checker and production shared-service connector both accepted the service before mutation.
- An in-memory snapshot of the actual development settings supplied the existing native trust to the production consent authority. No settings were persisted. The harness stopped on settings or registration changes.
- The real production Effect generation layer used the real connector, SDK, native catalog, and authenticated HTTP service; none was mocked. The activation dependency supplied its actual consent authority only: no foreground plugin installation or chat admission ran.
- Selection was exactly `opencodeV2` / account `opencode` / model `gpt-6-luna` / variant `none`, already available in the native catalog. This did not alter the configured generation preference or an existing chat's selection.
- Explicit harness inputs were synthetic theme-toggle messages, transcript, and diff text. The harness did not read repository file contents, existing chat transcripts, or private tool output into those inputs. Native-loaded Location instructions/context were not audited; the fetch audit does not establish the complete payload ultimately sent to the model.
- A process-local fetch audit permitted mutations only to the auxiliary sessions created by this run. It checked the 96-character `ses_bbtg_` IDs, text-generation provenance, and deny-all permissions. No message, inbox, configuration, or RPC route was accessed.

## Results

| Operation                       | Validated nonempty output                     | Result |
| ------------------------------- | --------------------------------------------- | ------ |
| `generateThreadTitle`           | `title`                                       | Passed |
| `generateThreadElevatorSummary` | `summary`                                     | Passed |
| `generateBranchName`            | `branch`                                      | Passed |
| `generateCommitMessage`         | `subject`, `body`, combined branch suggestion | Passed |
| `generatePrContent`             | `title`, `body`                               | Passed |
| `generatePromptSuggestion`      | `suggestion`                                  | Passed |

The completed six-operation run issued six native generation requests, created six auxiliary sessions, and received successful cleanup for all six. Existing chat sessions were not mutation targets. No Git commit, branch rename, push, or PR was created. The shared service was not restarted, stopped, or reconfigured.

An initial harness attempt generated one title and cleaned up its auxiliary session, then failed in the harness's result-field inspection: Effect Result's serialized `value` differs from its actual `success` property. Correcting the temporary harness—not production code—allowed the complete run above. Total authorized native usage was therefore seven generation calls and seven cleaned-up auxiliary sessions; no ambiguous request was automatically retried.

## Evidence and limits

Local sanitized evidence and the temporary harness were retained in the approved OpenCode temporary directory:

- `v2-textgen-live-openapi-2026-10-21.json`
- `v2-textgen-live-results-2026-10-21.json`
- `v2-textgen-live-initial-harness-2026-10-21.json`
- `v2-textgen-live-smoke-2026-10-21.ts`

These temporary files are not committed or permanent qualification records. This report records the bounded observed results without credentials, native session IDs, or generated private content.

The router's model-candidate policy, durable pre-dispatch claims, settings races, interruption/restart, uncertainty holds, and capacity accounting remain covered by the separate integration regressions and independent implementation review. This smoke invoked the concrete production generation layer directly; it did not exercise the complete foreground event pipeline, a visible desktop Retry action, or automatic attachment of generated metadata to a canonical thread.

No qualification-registry entry or global capability promotion is justified by this smoke alone. Results apply to the stated SDK/native/model/account/variant combination; they do not retroactively qualify native `2.0.32` or another deployment.
