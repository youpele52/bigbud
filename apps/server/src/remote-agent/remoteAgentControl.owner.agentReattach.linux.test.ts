import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { connect } from "node:net";

import { expect, it } from "vitest";

import type { AgentControlState } from "../ssh/sshOwnerPickerProof.codec.agentControl.ts";
import { PickerProofOwnerError } from "../ssh/sshOwnerPickerProof.codec.wire.ts";
import { openOwnerRemoteAgentControl } from "./remoteAgentControl.owner.install.ts";
import { remoteAgentOwnerOperands } from "./remoteAgentControl.owner.ts";
import {
  external,
  harnessShell,
  LABEL,
  liveReady,
  withOwner,
  type OwnerLive,
} from "./remoteAgentControl.owner.live.fixture.ts";

async function settle(owner: OwnerLive, lease: Uint8Array, state: AgentControlState) {
  let current = state;
  while (current.phase === "running" || current.phase === "listening") {
    await new Promise((resolve) => setTimeout(resolve, 20));
    current = await owner.bound.agentControlStatus(lease);
  }
  return current;
}

/**
 * U25 acceptance (live): a lease token is the operation identity. Re-opening a settled token,
 * reading it after the target reconnects, or cancelling it never runs the kind again; an unknown
 * token is refused. Agent bytes are not needed here (local build, not release-trusted, E7 open).
 */
it.skipIf(!liveReady)(
  `reattaches by lease token without replaying, across a reconnect (${LABEL})`,
  async () => {
    harnessShell(external!, 'rm -rf -- "$HOME/.bigbud"');
    await withOwner(async (owner) => {
      const control = await openOwnerRemoteAgentControl(owner.live, owner.targetId);
      const before = await control.registry.read();
      const next = JSON.stringify({ ...before, revision: before.revision + 1 });
      const { operands, input } = remoteAgentOwnerOperands({
        kind: "registryCas",
        expected: null,
        next,
      });
      const lease = randomBytes(32);
      const opened = await owner.bound.openAgentControl(lease, operands);
      expect(opened.phase).toBe("listening");
      const socket = connect({ path: (opened as { socketPath: string }).socketPath });
      await once(socket, "connect");
      await new Promise<void>((resolve) => socket.end(input!, () => resolve()));
      const committed = await settle(owner, lease, opened);
      expect(committed).toMatchObject({ phase: "exited", exitCode: 0, stdout: "committed" });

      // Re-open with the same token: the retained outcome, no second CAS (which would conflict).
      const again = await owner.bound.openAgentControl(lease, operands);
      expect(again).toEqual(committed);
      expect((await control.registry.read()).revision).toBe(before.revision + 1);

      // Reconnect the target's transport, then read the same token back.
      await owner.bound.disconnect().catch(() => undefined);
      await owner.bound.connect().catch(() => undefined);
      const after = await owner.bound.agentControlStatus(lease).catch((cause: unknown) => cause);
      console.log(
        `tagent-live reattach-after-reconnect=${after instanceof PickerProofOwnerError ? after.code : "retained"}`,
      );
      if (after instanceof PickerProofOwnerError) {
        // A reconnect that retires the target's lanes drops the retained outcome: the token is
        // then refused, never re-run.
        expect(after.code).toBe("operationDenied");
      } else {
        expect(after).toEqual(committed);
      }
      expect((await control.registry.read()).revision).toBe(before.revision + 1);

      // Cancelling a settled lease is idempotent and reports the same outcome.
      const fresh = randomBytes(32);
      const clock = await owner.bound.openAgentControl(fresh, { kind: "hostClock" });
      const settled = await settle(owner, fresh, clock);
      expect(await owner.bound.cancelAgentControl(fresh)).toEqual(settled);

      // A token this owner never accepted is a refusal, not a new operation.
      await expect(owner.bound.agentControlStatus(randomBytes(32))).rejects.toMatchObject({
        code: "operationDenied",
      });
    });
  },
  300_000,
);
