import {
  REMOTE_AGENT_INSTALL_TOOL_DESCRIPTION,
  REMOTE_AGENT_STATUS_TOOL_DESCRIPTION,
} from "../orchestration-tools/remoteAgentTools.shared.ts";
import type { CapabilityTrack } from "./CapabilityCatalog.ts";
import { threadToolTrack } from "./BigbudCapabilityTracks.helpers.ts";

const AVAILABILITY = [
  "Codex, Claude, CLI Proxy, Copilot, Cursor, Devin, Muse, OpenCode and Pi bridges, on a desktop backend with the bigbud remote agent.",
];

/** Phase 5: remote-agent status and installation through the shared install operation. */
export const REMOTE_AGENT_CAPABILITY_TRACKS: ReadonlyArray<CapabilityTrack> = [
  threadToolTrack({
    id: "remote_agent.status",
    displayName: "Remote agent status",
    description: REMOTE_AGENT_STATUS_TOOL_DESCRIPTION,
    summary: "Check a saved remote host's agent.",
    availability: AVAILABILITY,
    triggers: ["A remote project fails to connect or the user asks about its agent version."],
    risk: "read-only",
    workflow:
      "Call remote_agent_status with the saved target ID or an SSH alias such as user@host. Report whether it is installed and the current and pending versions plainly; it does not check liveness.",
    permissions:
      "Read-only. Reads the remote registry over the backend's SSH access; never changes the host.",
    examples: ["Check the remote agent on dev@vps."],
    antiPatterns: ["Do not pass shell commands or arbitrary hostnames as targets."],
  }),
  threadToolTrack({
    id: "remote_agent.install",
    displayName: "Remote agent install",
    description: REMOTE_AGENT_INSTALL_TOOL_DESCRIPTION,
    summary: "Install or replace an approved host's agent.",
    availability: AVAILABILITY,
    triggers: ["The user asks to install, repair or update the remote agent on a saved host."],
    risk: "reversible-write",
    workflow:
      "Call remote_agent_install with target (replace: true retires idle older builds). While state is running, call again with the same operationId. Report active, staged, deferred, failed or uncertain truthfully, and cleanupDeferred separately.",
    permissions:
      "Only remote targets saved in bigbud; other hosts are refused and agents cannot consent, so ask the user. Installs only the base agent; never provider tools or a backend runtime. Live work is never interrupted.",
    examples: ["Install the remote agent on dev@vps and report whether it is active."],
    antiPatterns: [
      "Never start a second install while one is running; follow its operationId.",
      "Never claim staged or deferred means active.",
    ],
  }),
];
