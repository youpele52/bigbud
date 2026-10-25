import { expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { makeV2ThreadPluginFixture } from "./Orchestration.plugin.fixture.ts";
import { V2ThreadRecords } from "./Orchestration.records.ts";
import { V2ThreadReceipts } from "./Orchestration.receipts.ts";
import { v2ThreadImplementation } from "./Orchestration.implementation.ts";
import { encodeV2FinalResult } from "./Orchestration.implementation.boundary.ts";
import { prepareV2OrchestrationRequest } from "./Execution.orchestration.ts";

it("completed A final JSON bypasses B interpretation/preparation, while identical stable identity/raw input cannot mint a new invocation", async () => {
  const app = await makeV2ThreadPluginFixture();
  try {
    const records = await V2ThreadRecords.open(
      app.artifact.root,
      "receipts",
      app.artifact.privateKey,
      app.artifact.publicKey,
    );
    const receipts = new V2ThreadReceipts(records),
      a = v2ThreadImplementation("v1"),
      b = v2ThreadImplementation("v2");
    const identity = ["storage", "turn", "native", "message", "call"],
      key = JSON.stringify(identity),
      raw = {};
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(["list_threads", raw]))
      .digest("hex");
    const prepared = prepareV2OrchestrationRequest(
      a.prepare({ action: "list_threads", input: raw, callerThreadId: "caller" }),
      identity,
    );
    expect(prepared.invocationId).toBe(
      `v2-tool:${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`,
    );
    const result = await receipts.run(
      key,
      fingerprint,
      async () =>
        encodeV2FinalResult(
          a.interpret({ action: "list_threads", canonicalResult: { ok: true, threads: [] } }),
        ),
      {
        implementationDigest: a.implementationDigest,
        requestDigest: createHash("sha256").update(JSON.stringify(prepared)).digest("hex"),
        resultEncoding: a.resultEncoding,
      },
    );
    const interpretB = vi.fn(() =>
      encodeV2FinalResult(
        b.interpret({ action: "list_threads", canonicalResult: JSON.parse(result.content) }),
      ),
    );
    const returned = await receipts.once(key, fingerprint, async () => {
      const existing = await receipts.find(key, fingerprint);
      if (existing) return existing;
      return interpretB();
    });
    expect(returned).toEqual(result);
    expect(interpretB).not.toHaveBeenCalled();
    await expect(receipts.find(key, "changed-raw-input")).rejects.toThrow("uncertain or changed");
    expect((await records.read(key))?.value).toMatchObject({
      format: "bigbud.thread.receipt.v2",
      state: "completed",
      implementationDigest: a.implementationDigest,
      result: { content: '{"ok":true,"threads":[]}' },
    });
  } finally {
    await app.close();
  }
});

it("interpretation/encoding failure after physical dispatch leaves durable reserved uncertainty with no automatic resend", async () => {
  const app = await makeV2ThreadPluginFixture();
  try {
    const records = await V2ThreadRecords.open(
        app.artifact.root,
        "receipts",
        app.artifact.privateKey,
        app.artifact.publicKey,
      ),
      receipts = new V2ThreadReceipts(records),
      handler = v2ThreadImplementation();
    const dispatch = vi.fn(async () => {
      throw new Error("Owned interpretation failure after HTTP result");
    });
    const metadata = {
      implementationDigest: handler.implementationDigest,
      requestDigest: "f".repeat(64),
      resultEncoding: handler.resultEncoding,
    };
    await expect(receipts.run("identity", "fingerprint", dispatch, metadata)).rejects.toThrow(
      "interpretation failure",
    );
    expect((await records.read("identity"))?.value).toMatchObject({
      state: "reserved",
      implementationDigest: handler.implementationDigest,
    });
    await expect(receipts.run("identity", "fingerprint", dispatch, metadata)).rejects.toThrow(
      "uncertain or changed",
    );
    expect(dispatch).toHaveBeenCalledTimes(1);
  } finally {
    await app.close();
  }
});
