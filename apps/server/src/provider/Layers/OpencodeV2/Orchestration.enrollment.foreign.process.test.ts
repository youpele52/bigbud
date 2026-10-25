import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { makeV2ThreadPluginFixture } from "./Orchestration.plugin.fixture.ts";
import { V2ThreadRecords } from "./Orchestration.records.ts";
import { V2EnrollmentRetirement } from "./Orchestration.enrollment.retirement.ts";

async function independentReader(input: unknown) {
  const child = spawn(
    "bun",
    [
      fileURLToPath(
        new URL("./Orchestration.enrollment.foreign.process.fixture.ts", import.meta.url),
      ),
    ],
    {
      cwd: process.cwd(),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => {
    if (output.length < 4096) output += chunk.toString();
  });
  child.stderr.resume();
  child.stdin.end(JSON.stringify(input));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Independent synthetic reader deadline."));
    }, 15000);
    child.once("error", () => {
      clearTimeout(timer);
      reject(new Error("Independent synthetic reader failed."));
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error("Independent synthetic reader exited unsuccessfully."));
    });
  });
  return JSON.parse(output.trim());
}

it("independent concurrent readers cannot admit foreign history after expiry or detach acknowledgement alone", async () => {
  const app = await makeV2ThreadPluginFixture();
  try {
    const records = await V2ThreadRecords.open(
        app.artifact.root,
        "enrollments",
        app.artifact.privateKey,
        app.artifact.publicKey,
      ),
      owner = app.bind("foreign-physical-owner", "/synthetic-Location"),
      signed = app.envelope("enroll", 1, Date.now() + 1000),
      digest = signed.ownerDigest;
    const key = JSON.stringify([owner.storageIdentity, owner.nativeSessionId, owner.threadId]);
    await records.replace(key, undefined, {
      owner,
      digest,
      state: "active",
      acknowledged: { revision: 1, expiry: Date.now() - 10000 },
      pending: null,
    });
    const input = {
      root: app.artifact.root,
      privateKey: app.artifact.privateKey,
      publicKey: app.artifact.publicKey,
      scope: {
        storageIdentity: owner.storageIdentity,
        nativeSessionId: owner.nativeSessionId,
        threadId: owner.threadId,
        directory: owner.directory,
      },
    };
    const before = await records.read(key);
    expect(await Promise.all([independentReader(input), independentReader(input)])).toEqual([
      { state: "blocked", nativeCalls: 0 },
      { state: "blocked", nativeCalls: 0 },
    ]);
    expect(await records.read(key)).toEqual(before);
    const retirement = await V2EnrollmentRetirement.open(records),
      identity = {
        wireProtocol: owner.protocol,
        ownerDigest: digest,
        enrollmentNonce: owner.enrollmentNonce,
        directory: owner.directory,
        nativeSessionId: owner.nativeSessionId,
      };
    await retirement.begin(identity, signed);
    const missing = {
      state: "missing" as const,
      ownerDigest: digest,
      enrollmentNonce: owner.enrollmentNonce,
      revision: 0,
      expiry: 0,
    };
    await retirement.acknowledge(
      identity,
      { ...missing, state: "revoked" },
      missing,
      app.artifact.artifactDigest,
      "synthetic-generation",
    );
    expect(await independentReader(input)).toEqual({ state: "blocked", nativeCalls: 0 });
    await retirement.settle(identity, {
      physicalSettled: true,
      controlsSettled: true,
      callbacksSettled: true,
      creationSettled: true,
      admissionsSettled: true,
      receiptsSettled: true,
    });
    expect(await independentReader(input)).toEqual({ state: "settled", nativeCalls: 0 });
    expect(await records.read(key)).toEqual(before);
  } finally {
    await app.close();
  }
});
