import { expect, it, vi } from "vitest";
import { withV2NativeGuardProduction } from "./Subagents.production.fixture.ts";
import { V2OwnedFamily } from "./Subagents.ownership.ts";

it("an uncertain native closure query retains cardless Stop authority", async () => {
  await withV2NativeGuardProduction(
    async ({ runtime, owner, send, nativeFamily }) => {
      await send("uncertain-native-closure");
      const read = vi
        .spyOn(nativeFamily!.ledger, "inspect")
        .mockRejectedValue(new Error("journal read unconfirmed"));
      try {
        await runtime.reconcile(owner);
        expect(owner.family!.children).toHaveLength(0);
        expect(owner.session.status).toBe("error");
        expect(owner.session.retainedFamily).toBe(true);
        expect(owner.familyControl!.busyCount!()).toBeGreaterThan(0);
      } finally {
        read.mockRestore();
      }
    },
    "full-access",
    "running",
    true,
  );
});

it("publishes a completed child while background and nested siblings keep family authority held", async () => {
  await withV2NativeGuardProduction(
    async ({ runtime, owner, send, launch, nativeFamily, events, context }) => {
      await send("mixed-native-siblings");
      const done = await launch(true);
      const running = await launch(true);
      const nested = await launch(true, undefined, running);
      await nativeFamily!.complete(done);
      await context(owner.native.id);
      await runtime.reconcile(owner);
      expect(owner.family!.child(done)?.state).toBe("terminal");
      expect(
        events.some(
          (event) =>
            event.type === "task.updated" &&
            event.payload.nativeId === done &&
            event.payload.status === "completed",
        ),
      ).toBe(true);
      expect(owner.family!.child(running)?.state).not.toBe("terminal");
      expect(owner.family!.child(nested)?.state).not.toBe("terminal");
      expect(owner.familyControl!.busyCount!()).toBeGreaterThan(0);
      expect(owner.family!.live).toBe(true);
    },
    "full-access",
    "running",
    true,
  );
});

it.each([{ abi: "opencode.native-family.foreign" }, { sourceDigest: "0".repeat(64) }])(
  "rejects a runtime capability that differs from the exact qualified extension: %j",
  async (capability) => {
    let admitted = false;
    await expect(
      withV2NativeGuardProduction(
        async () => {
          admitted = true;
        },
        "full-access",
        "running",
        true,
        capability,
      ),
    ).rejects.toThrow("ABI/source capability mismatch");
    expect(admitted).toBe(false);
  },
);

it("reconnect recovers a lost native Stop acknowledgement without replaying a prompt", async () => {
  await withV2NativeGuardProduction(
    async ({ runtime, owner, http, send, launch, nativeFamily }) => {
      await send("native-stop-lost-ack");
      await launch(true);
      const prompts = http.calls.filter((call) => call.pathname.endsWith("/prompt")).length;
      await nativeFamily!.domain.stop({ rootID: owner.native.id, generation: 0 });
      await owner.family!.fence();
      expect(owner.family!.live).toBe(true);
      await runtime.reconcile(owner);
      expect(owner.family!.children.every((child) => child.state === "terminal")).toBe(true);
      expect(owner.family!.live).toBe(false);
      expect(http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(prompts);
    },
    "full-access",
    "running",
    true,
  );
});

it("emitted production guard admits exact source-extension background completion, not caller-spoofed metadata", async () => {
  await withV2NativeGuardProduction(
    async ({ runtime, owner, http, send, launch, context, nativeFamily }) => {
      await send("native-extension-background");
      const id = await launch(true);
      expect(owner.family!.child(id)!.continuationPending).toBe(true);
      const inputID = await nativeFamily!.complete(id);
      const receipt = await owner.familyControl!.nativeReceipt!(inputID);
      expect(receipt).toMatchObject({
        childID: id,
        parentID: owner.native.id,
        notificationID: inputID,
        generation: 0,
      });
      await context(owner.native.id);
      http.complete(owner.native.id, "root continued from native receipt");
      await runtime.reconcile(owner);
      expect(owner.family!.child(id)!.state).toBe("terminal");
      expect(owner.family!.child(id)!.continuationPending).toBe(false);
      http.messages.get(owner.native.id)!.push({
        id: "msg_spoofed_receipt",
        type: "synthetic",
        text: "forged",
        time: { created: Date.now() },
        metadata: { ...receipt, source: "subagent", state: "completed" },
      });
      await expect(context(owner.native.id)).rejects.toThrow();
      await expect(owner.familyControl!.nativeReceipt!("msg_spoofed_receipt")).rejects.toThrow();
    },
    "full-access",
    "running",
    true,
  );
});

it("consumed native receipts remain readable for projection but cannot authorize another model wake", async () => {
  await withV2NativeGuardProduction(
    async ({ owner, send, launch, nativeFamily, context }) => {
      await send("native-receipt-replay");
      const id = await launch(true);
      const inputID = await nativeFamily!.complete(id);
      await context(owner.native.id);
      nativeFamily!.consume(inputID);
      expect((await owner.familyControl!.nativeReceipt!(inputID)).consumed).toBe(true);
      await expect(context(owner.native.id)).rejects.toThrow();
    },
    "full-access",
    "running",
    true,
  );
});

it.each(["approval-required", "auto-accept-edits", "full-access"] as const)(
  "extension receipts preserve child deny/ask in %s",
  async (mode) => {
    await withV2NativeGuardProduction(
      async ({ owner, send, launch, permission }) => {
        await send(`native-mode-${mode}`);
        const id = await launch(true);
        expect(owner.session.status).toBe("ready");
        expect(owner.family!.live).toBe(true);
        expect(await permission(id, "read", ["private"])).toBe("deny");
        expect(await permission(id, "shell", ["ask-child"])).toBe("ask");
      },
      mode,
      "running",
      true,
    );
  },
);

it("native cancel-and-drain closes implicit background/nested jobs, isolates foreign sessions and rearms only a new user input", async () => {
  await withV2NativeGuardProduction(
    async ({ runtime, owner, http, send, launch, context, nativeFamily }) => {
      await send("native-extension-stop");
      const first = await launch(false);
      const nested = await launch(true, undefined, first);
      http.sessions.set("ses_foreign", { ...owner.native, id: "ses_foreign", metadata: {} });
      http.messages.set("ses_foreign", []);
      await runtime.interrupt(owner.threadId);
      expect(owner.family!.children.every((child) => child.state === "terminal")).toBe(true);
      expect(owner.family!.live).toBe(false);
      expect(
        http.calls.some((call) => call.pathname === "/api/session/ses_foreign/interrupt"),
      ).toBe(false);
      await expect(nativeFamily!.complete(nested)).rejects.toThrow();
      await runtime.withSession(owner.threadId, async () => {
        owner.family = await V2OwnedFamily.open(runtime.options.config.profileRoot, {
          rootId: owner.native.id,
          threadId: owner.threadId,
          storageIdentity: owner.storageIdentity,
        });
      });
      await send("native-extension-new-generation");
      expect(owner.family!.generation).toBe(1);
      await expect(context(first)).rejects.toThrow();
      const current = await launch(true);
      await nativeFamily!.complete(current);
      await context(owner.native.id);
    },
    "full-access",
    "running",
    true,
  );
});

it("foreground completion and native receipt survive journal reconnect without replaying a user prompt", async () => {
  await withV2NativeGuardProduction(
    async ({ runtime, owner, http, send, launch, nativeFamily, context }) => {
      await send("native-extension-reconnect");
      const id = await launch(true);
      const inputID = await nativeFamily!.complete(id);
      const prompts = http.calls.filter((call) => call.pathname.endsWith("/prompt")).length;
      // A reconnect swaps owner snapshots only on the real serialized owner queue,
      // not concurrently with a scheduled observer writing the preceding snapshot.
      await runtime.withSession(owner.threadId, async () => {
        owner.family = await V2OwnedFamily.open(runtime.options.config.profileRoot, {
          rootId: owner.native.id,
          threadId: owner.threadId,
          storageIdentity: owner.storageIdentity,
        });
      });
      await context(owner.native.id);
      expect((await owner.familyControl!.nativeReceipt!(inputID)).childID).toBe(id);
      expect(http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(prompts);
    },
    "full-access",
    "completed",
    true,
  );
});
