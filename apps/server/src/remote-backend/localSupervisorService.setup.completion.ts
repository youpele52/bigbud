import { SERVICE_SETUP_REQUEST_ID } from "./localSupervisorService.setup.types.ts";
import * as fs from "node:fs/promises";
import * as Schema from "effect/Schema";
import { join } from "node:path";
import {
  RemoteBackendAuthority,
  RemoteBackendInstallationFingerprint,
} from "@bigbud/contracts/server/remoteBackendHandshake";
import type { LocalSupervisorPreflightContext } from "./localSupervisorService.preflight.ts";
import type { RemoteAgentRuntime } from "../remote-agent/remoteAgentRuntime.ts";
import { remoteAgentBuildId } from "../remote-agent/remoteAgentRuntime.ts";
import { readLocalSupervisorServiceFile } from "./localSupervisorService.files.ts";
const Decimal = Schema.String.check(Schema.isPattern(/^[0-9]+$/));
const Completion = Schema.Struct({
  version: Schema.Literals([1]),
  requestId: Schema.String.check(Schema.isPattern(SERVICE_SETUP_REQUEST_ID)),
  authority: RemoteBackendAuthority,
  installationFingerprint: RemoteBackendInstallationFingerprint,
  backendStateDir: Schema.String,
  backendStateDev: Decimal,
  backendStateIno: Decimal,
  backendStateUid: Decimal,
  initialBuildId: Schema.String,
  initialEpoch: Decimal,
});
/** Immutable initial outcome only. Its epoch/build are historical, never current readiness. */
export async function serviceSetupCompletion(
  context: LocalSupervisorPreflightContext,
  requestId: string,
  runtime: RemoteAgentRuntime,
  epoch: string,
) {
  const state = await fs.lstat(context.owner.stateDir, { bigint: true });
  return (
    JSON.stringify(
      Schema.decodeUnknownSync(Completion)(
        {
          version: 1,
          requestId,
          authority: {
            authorityId: context.identity.authority.authorityId,
            keyEpoch: context.identity.authority.keyEpoch,
            keyFingerprint: context.identity.authority.keyFingerprint,
          },
          installationFingerprint: context.identity.installationFingerprint,
          backendStateDir: context.owner.stateDir,
          backendStateDev: state.dev.toString(),
          backendStateIno: state.ino.toString(),
          backendStateUid: state.uid.toString(),
          initialBuildId: remoteAgentBuildId(runtime),
          initialEpoch: epoch,
        },
        { onExcessProperty: "error" },
      ),
    ) + "\n"
  );
}
export async function requireServiceSetupCompletion(
  root: string,
  context: LocalSupervisorPreflightContext,
) {
  const record = Schema.decodeUnknownSync(Completion)(
    JSON.parse(await readLocalSupervisorServiceFile(join(root, "setup-complete-v1"), 16 * 1024)),
    { onExcessProperty: "error" },
  );
  const state = await fs.lstat(context.owner.stateDir, { bigint: true });
  if (
    record.authority.authorityId !== context.identity.authority.authorityId ||
    record.installationFingerprint !== context.identity.installationFingerprint ||
    record.backendStateDir !== context.owner.stateDir ||
    record.backendStateDev !== state.dev.toString() ||
    record.backendStateIno !== state.ino.toString() ||
    record.backendStateUid !== state.uid.toString()
  )
    throw new Error("Initial setup completion belongs to another backend namespace.");
  // Current config, graph, native status and canonical binding are checked separately by inspection.
  return record;
}
