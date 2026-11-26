import { createHash } from "node:crypto";

import { expect, it } from "vitest";

import {
  compileRemoteAgentControlOp,
  type RemoteAgentControlOp,
} from "./remoteAgentControl.ops.ts";
import { compileRemoteAgentInstallControlOp } from "./remoteAgentControl.ops.install.ts";
import { makeRemoteAgentOwnerExec, type RemoteAgentOwnerOp } from "./remoteAgentControl.owner.ts";
import {
  external,
  harnessShell,
  LABEL,
  liveReady,
  withOwner,
} from "./remoteAgentControl.owner.live.fixture.ts";

/**
 * U25 parity (live): the same operation sequence run once as the legacy script (sent over the
 * test harness's own SSH, like the legacy runner's `sh -lc`) and once as owner `agent_control`
 * kinds, each from an empty `~/.bigbud`. Outputs and the resulting registry, inventory and
 * install layout must be identical.
 */
const fresh = () => harnessShell(external!, 'rm -rf -- "$HOME/.bigbud"');
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const withoutClock = (text: string) => text.replace(/^clock=\d+\n/, "");
const tree = () =>
  harnessShell(
    external!,
    'cd "$HOME/.bigbud/agent" && find . \\( -name "*.lock" -o -name ".*.XXXXXX" \\) -prune -o -printf "%p %m %s\\n" | sort',
  );

it.skipIf(!liveReady)(
  `legacy scripts and owner kinds leave identical state (${LABEL})`,
  async () => {
    await withOwner(async (owner) => {
      const exec = makeRemoteAgentOwnerExec(owner.live, owner.targetId);
      const bytes = Buffer.from("#!/bin/sh\nexit 0\n".repeat(4096));
      const artifact = {
        version: "0.0.1-parity",
        sha256: createHash("sha256").update(bytes).digest("hex"),
        sizeBytes: bytes.length,
        targetTriple: "aarch64-unknown-linux-gnu" as const,
      };
      const first = JSON.stringify({ parity: 1 });
      const second = JSON.stringify({ parity: 2 });
      const sequence: ReadonlyArray<RemoteAgentControlOp | RemoteAgentOwnerOp> = [
        { kind: "controlRoot" },
        { kind: "registryCas", expected: null, next: first },
        { kind: "registryCas", expected: null, next: second },
        { kind: "registryCas", expected: first, next: second },
        { kind: "registryRead" },
        { kind: "installUpload", artifact, reservationId: "parity-1", bytes },
        { kind: "placedProbe", artifact },
        { kind: "inventory" },
        { kind: "stageFenceRevoke", reservationId: "parity-1" },
        { kind: "removalOutcome" },
      ];

      fresh();
      const root = harnessShell(external!, 'printf %s "$(readlink -f -- "$HOME")/.bigbud/agent"');
      const legacy: string[] = [];
      for (const op of sequence) {
        const script =
          op.kind === "installUpload" || op.kind === "placedProbe"
            ? compileRemoteAgentInstallControlOp(op)
            : compileRemoteAgentControlOp(root, op as RemoteAgentControlOp);
        const stdin =
          op.kind === "installUpload"
            ? Buffer.from(Buffer.from(bytes).toString("base64"))
            : undefined;
        legacy.push(withoutClock(harnessShell(external!, `sh -lc ${quote(script)}`, stdin)));
      }
      const legacyTree = tree();

      fresh();
      const owned: string[] = [];
      for (const op of sequence)
        owned.push(withoutClock((await exec(op as RemoteAgentOwnerOp)).stdout));
      const ownedTree = tree();

      expect(owned).toEqual(legacy);
      expect(ownedTree).toBe(legacyTree);
      expect(legacy[1]).toBe("committed");
      expect(legacy[2]).toBe("conflict");
      expect(legacy[3]).toBe("committed");
      expect(legacy[6]).toBe("managed");
      fresh();
    });
  },
  300_000,
);
