# KiloCode removal

Status: Implemented; focused validation complete, including the mobile queue rejection-reason compatibility fix. See [validation](../validation/kilocode-removal-2026-10-29.md).

## Research and compatibility

KiloCode is a provider and adapter built on the shared OpenCode V1 protocol. Its runtime is composed in `apps/server/src/server.ts`, both provider registries, managed-server health/catalog helpers, discovery, terminal detection, contracts, and client model pickers. The existing `PersistedModelSelection` deliberately accepts arbitrary provider IDs, but research found stored thread/project/event DTOs and wire hydration still used active routing schemas. Preserve KiloCode through an explicit historical-selection union across stored DTOs, projection schemas and UI hydration, with active routing and read-only guards kept separate.

No Kilo-specific dependency is installed: OpenCode SDK usage remains shared with existing OpenCode V1 modules. Historical changelogs, research and validation documents remain historical records. Removing this integration does not uninstall users' external Kilo CLI or delete their files.

## Implementation

1. Remove KiloCode from active provider/model/settings contracts and model helpers; preserve lossless persisted selections and prove active routing rejects KiloCode.
2. Remove runtime provider/adapter modules and composition, probes, catalog/config branches, capabilities, discovery paths, and terminal-agent detection. Narrow shared OpenCode V1 code to OpenCode without changing V2 behavior.
3. Remove desktop/mobile selection and settings, icon assets, and current marketing claims. Existing KiloCode chats remain available through the established unavailable-provider history handling.
4. Replace Kilo-specific fixtures in shared protocol tests with OpenCode fixtures or remove redundant provider-only cases. Add focused removal/compatibility assertions.
5. Run explicit-path formatting and lint, <=400-line checks for changed authored source/tests, affected package typechecks and focused tests. Review all requirements and report any unrelated pre-existing failures. No broad validation or git publication.

## Acceptance evidence

- Active provider enumeration, model selection, runtime registries and discovery contain no KiloCode integration.
- Saved KiloCode model selections decode without losing provider, model, options, or sub-provider.
- KiloCode cannot start runtime work and is absent from settings/pickers/current marketing.
- OpenCode shared protocol and other providers retain focused regression coverage.
