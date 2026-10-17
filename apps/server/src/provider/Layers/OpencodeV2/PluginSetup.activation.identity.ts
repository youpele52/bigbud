import type { V2OwnedActivationJob } from "./PluginSetup.activation.jobs.ts";
import type { V2ActivationGate } from "./PluginSetup.activation.gate.ts";
import type { V2PluginSetupAuthority } from "./PluginSetup.paths.ts";
import { V2ActivationWindow } from "./PluginSetup.activation.window.ts";
import { V2ActivationBusy } from "./PluginSetup.activation.errors.ts";

/** A closed local admission fence and exact-root publisher lock suffice for signed metadata only.
 * Foreign enrollments and native work remain untouched: no plugin/owner/runtime scope changes. */
export function makeV2IdentityPublication(
  job: V2OwnedActivationJob,
  gate: V2ActivationGate,
  participants: ReadonlyMap<string, { busyCount: () => number }>,
  freshAuthority: (signal: AbortSignal) => Promise<void>,
) {
  let window: V2ActivationWindow | undefined,
    closed = false;
  const release = () => {
    if (!closed) return;
    closed = false;
    gate.releaseGate(job.id);
    window?.release();
  };
  const assertGate = () => {
    job.assertCurrent();
    if (closed) {
      window!.assertCurrent();
      gate.assertGate(job.id);
    } else if (window) {
      window.signal.throwIfAborted();
      throw new Error("V2 identity maintenance gate was released; no late metadata authority.");
    }
  };
  const authority: NonNullable<V2PluginSetupAuthority["publication"]> = {
    joinPhysicalOnCancel: true,
    assertGate,
    prepare: async () => {
      job.assertCurrent();
      job.phase("prepared");
    },
    locked: async () => {
      job.assertCurrent();
      job.phase("closing-gate");
      if (!gate.tryCloseGate(job.id))
        throw new V2ActivationBusy("V2 identity maintenance lost local admission.");
      closed = true;
      window = new V2ActivationWindow(gate.gateDeadline(job.id), job.signal, () => {
        release();
        if (!job.signal.aborted)
          job.phase(
            "uncertain",
            "V2 identity maintenance gate expired; no new metadata write is authorized.",
          );
      });
      try {
        await window.run(async () => {
          assertGate();
          if ([...participants.values()].some((owner) => owner.busyCount()))
            throw new V2ActivationBusy(
              "V2 identity maintenance awaits local admission settlement; retained owners are unchanged.",
            );
          await freshAuthority(window!.signal);
          assertGate();
        });
        return release;
      } catch (error) {
        window.controller.abort();
        release();
        throw error;
      }
    },
    beforeMutation: async () => {
      if (!closed || !window) throw new Error("V2 identity maintenance requires closed admission.");
      await window.run(async () => {
        assertGate();
        await freshAuthority(window!.signal);
        assertGate();
        job.phase("publishing");
      });
    },
    observePhysical: (operation) => window?.observe(operation),
    joinPhysical: async () => {
      await window?.drain();
    },
  };
  return {
    authority,
    close: async () => {
      release();
      await window?.drain();
    },
  };
}
