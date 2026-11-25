import { describe, expect, it } from "vitest";

import {
  decodeTerminalHostFrame,
  encodeTerminalHostFrame,
} from "./remoteAgentProtocol.codec.terminalHost.ts";
import type { RemoteAgentFrame } from "./remoteAgentProtocol.ts";

const frames: ReadonlyArray<RemoteAgentFrame> = [
  {
    type: "terminalHostInventoryRequest",
    value: { requestId: "r1", expectedEpoch: "e1", maxPanes: 64 },
  },
  {
    type: "terminalHostInventoryResponse",
    value: {
      requestId: "r1",
      agentEpoch: "e1",
      agentVersion: "1.0.0",
      buildDigest: "digest",
      ownerArtifactId: "1.0.0@digest",
      panes: [
        {
          ptyId: "pty-a",
          threadId: "thread-a",
          paneId: "pane-a",
          kind: "managed-ssh",
          ownerArtifactId: "1.0.0@digest",
          leaseId: "pty-a",
          canRetireSshSpawn: true,
        },
      ],
      truncated: false,
      sshSpawnRetirementAvailable: true,
      accepted: true,
      errorCode: "",
    },
  },
  {
    type: "terminalHostRetireSshSpawnRequest",
    value: {
      requestId: "r2",
      expectedEpoch: "e1",
      expectedBuildDigest: "digest",
      leaseIds: ["pty-a", "pty-b"],
    },
  },
  {
    type: "terminalHostRetireSshSpawnResponse",
    value: {
      requestId: "r2",
      agentEpoch: "e1",
      accepted: true,
      retiredLeaseIds: ["pty-a", "pty-b"],
      sshSpawnRetired: true,
      errorCode: "",
      errorMessage: "",
    },
  },
];

describe("terminal-host retirement protocol 1.10", () => {
  it.each(frames.map((frame) => [frame.type, frame] as const))(
    "round-trips %s and keeps the additive field numbers",
    (type, frame) => {
      const encoded = encodeTerminalHostFrame(frame);
      expect(encoded).toBeDefined();
      expect(
        [
          "terminalHostInventoryRequest",
          "terminalHostInventoryResponse",
          "terminalHostRetireSshSpawnRequest",
          "terminalHostRetireSshSpawnResponse",
        ].indexOf(type) + 128,
      ).toBe(encoded!.field);
      expect(decodeTerminalHostFrame(encoded!.field, encoded!.value)).toEqual(frame);
    },
  );

  it("does not decode an unknown verb", () => {
    expect(decodeTerminalHostFrame(132, new Uint8Array())).toBeUndefined();
  });
});
