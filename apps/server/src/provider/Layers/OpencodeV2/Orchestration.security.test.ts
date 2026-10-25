import { createServer } from "node:http";
import { chmod, link, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { makeV2ThreadPluginFixture } from "./Orchestration.plugin.fixture.ts";
import { V2ThreadRecords } from "./Orchestration.records.ts";
import { V2ThreadReceipts } from "./Orchestration.receipts.ts";
import { v2ThreadPrivateDirectory } from "./Orchestration.storage.ts";

it("signed private enrollment/receipt records reject tampering, links, and stale conditional replacement without repairing evidence", async () => {
  const app = await makeV2ThreadPluginFixture();
  try {
    const records = await V2ThreadRecords.open(
      app.artifact.root,
      "enrollments",
      app.artifact.privateKey,
      app.artifact.publicKey,
    );
    const revision = await records.replace("owner", undefined, { state: "pending" });
    const next = await records.replace("owner", revision, { state: "active" });
    await expect(records.replace("owner", revision, { state: "revoked" })).rejects.toThrow(
      "successor",
    );
    expect((await records.read("owner"))?.revision).toBe(next);
    const { readdir } = await import("node:fs/promises");
    const filename = path.join(records.directory, (await readdir(records.directory))[0]!);
    const original = await readFile(filename, "utf8");
    await writeFile(filename, original.replace('"active"', '"revoked"'));
    await expect(records.read("owner")).rejects.toThrow("signed record");
    await writeFile(filename, original);
    await link(filename, `${filename}.link`);
    await expect(records.read("owner")).rejects.toThrow("file rejected");
    await expect(records.replace("owner", next, { state: "revoked" })).rejects.toThrow(
      "file rejected",
    );
    await symlink(filename, path.join(records.directory, "foreign-symlink"));
    expect(await readFile(filename, "utf8")).toBe(original);
  } finally {
    await app.close();
  }
});

it("a dispatched uncertain receipt blocks new execution indefinitely and changed material never gains fresh identity", async () => {
  const app = await makeV2ThreadPluginFixture();
  try {
    const records = await V2ThreadRecords.open(
      app.artifact.root,
      "receipts",
      app.artifact.privateKey,
      app.artifact.publicKey,
    );
    const receipts = new V2ThreadReceipts(records);
    let effects = 0;
    await expect(
      receipts.run("stable-native-turn-call", "exact-arguments", async () => {
        effects++;
        throw new Error("lost acknowledgement");
      }),
    ).rejects.toThrow("lost");
    await expect(
      receipts.run("stable-native-turn-call", "exact-arguments", async () => {
        effects++;
        return { content: "duplicate" };
      }),
    ).rejects.toThrow("uncertain");
    await expect(receipts.find("stable-native-turn-call", "changed-arguments")).rejects.toThrow(
      "changed",
    );
    expect(effects).toBe(1);
  } finally {
    await app.close();
  }
});

it.skipIf(process.platform === "win32")(
  "private app assets refuse mutable ancestors without repairing their permissions",
  async () => {
    const app = await makeV2ThreadPluginFixture();
    try {
      await chmod(app.root, 0o777);
      await expect(v2ThreadPrivateDirectory(app.artifact.root)).rejects.toThrow("ancestor");
      await expect(
        (await import("node:fs/promises")).stat(app.root).then((info) => info.mode & 0o777),
      ).resolves.toBe(0o777);
    } finally {
      await chmod(app.root, 0o700);
      await app.close();
    }
  },
);

it("unsigned/rebound callback responses and malformed secret bodies cannot claim app success or leak response contents", async () => {
  const app = await makeV2ThreadPluginFixture();
  let reply = '{"active":true}';
  const server = createServer((_request, response) =>
    response.writeHead(200, { "content-type": "application/json" }).end(reply),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture port missing");
    const owner = {
      ...app.bind("native", app.root),
      callbackUrl: `http://127.0.0.1:${address.port}/invoke`,
    };
    const identity = await import(new URL("identity.mjs", app.artifact.entryUri).href);
    await expect(identity.callback(owner, { kind: "status" })).rejects.toThrow(
      "Required bigbud thread-tools integration rejected.",
    );
    reply = "malformed-SECRET-BEARER-FROM-NATIVE-body";
    const error = await identity
      .callback(owner, { kind: "status" })
      .catch((value: unknown) => value);
    expect(String(error)).toBe("Error: Required bigbud thread-tools integration rejected.");
    expect(String(error)).not.toContain("SECRET");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await app.close();
  }
});
