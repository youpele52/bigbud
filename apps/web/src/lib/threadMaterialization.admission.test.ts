import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { describe, expect, it } from "vitest";
import {
  admitThreadCreationForSend,
  markTerminalOwnerConfirmed,
  pendingThreadCreations,
} from "./threadMaterialization.admission";

describe("first-send and terminal creation admission", () => {
  it("retains ordinary first-send bootstrap creation when no terminal save was requested", async () => {
    const id = ThreadId.makeUnsafe("send-alone");
    const admission = await admitThreadCreationForSend(id, true);
    expect(admission.requiresCreate).toBe(true);
    const owner = pendingThreadCreations.get(id)!;
    admission.settle(true);
    await owner;
    expect(pendingThreadCreations.has(id)).toBe(false);
  });

  it("waits for a terminal save and removes createThread from the simultaneous first-send bootstrap", async () => {
    const id = ThreadId.makeUnsafe("terminal-first");
    let saved!: () => void;
    const terminalOwner = new Promise<void>((resolve) => {
      saved = resolve;
    });
    pendingThreadCreations.set(id, terminalOwner);
    const sending = admitThreadCreationForSend(id, true);
    saved();
    expect((await sending).requiresCreate).toBe(false);
    pendingThreadCreations.delete(id);
  });

  it("does not re-create an owner when React's draft flags lag a completed terminal save", async () => {
    const id = ThreadId.makeUnsafe("terminal-completed");
    markTerminalOwnerConfirmed(id);
    expect((await admitThreadCreationForSend(id, true)).requiresCreate).toBe(false);
  });

  it("releases failed creation without exposing a nonexistent durable owner to a terminal", async () => {
    const id = ThreadId.makeUnsafe("failed-send");
    const admission = await admitThreadCreationForSend(id, true);
    const terminalOwner = pendingThreadCreations.get(id)!;
    admission.settle(false);
    await expect(terminalOwner).rejects.toThrow("did not confirm chat creation");
    expect((await admitThreadCreationForSend(id, false)).requiresCreate).toBe(false);
  });
});
