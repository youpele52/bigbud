import { resolve } from "node:path";

import { findWorkspaceAgentTarget } from "../../../scripts/lib/workspace-agent-target.ts";
import { verifyWorkspaceAgentCleanupSmoke } from "../../../scripts/lib/workspace-agent-handshake.ts";
import {
  assertCompleteServerWorkspaceAgentSet,
  serverWorkspaceAgentPath,
} from "./workspaceAgent.ts";

import {
  assertCompleteOrganizationSupervisorSet,
  serverOrganizationSupervisorPath,
} from "./organizationSupervisor.ts";
import { smokeTestThreadOrganizationBinary } from "../../../scripts/lib/thread-organization-smoke.ts";

const serverDirectory = resolve(import.meta.dirname, "..");
assertCompleteServerWorkspaceAgentSet(serverDirectory);
assertCompleteOrganizationSupervisorSet(serverDirectory);
const hostTarget = findWorkspaceAgentTarget(process.platform, process.arch);
if (!hostTarget) {
  throw new Error(
    `Unsupported standalone server workspace watcher target: ${process.platform}/${process.arch}`,
  );
}
await verifyWorkspaceAgentCleanupSmoke(
  serverWorkspaceAgentPath(serverDirectory, hostTarget.platform, hostTarget.arch),
);
await smokeTestThreadOrganizationBinary(
  serverOrganizationSupervisorPath(serverDirectory, hostTarget.platform, hostTarget.arch),
);
console.log("Verified the complete standalone server workspace watcher artifact set.");
