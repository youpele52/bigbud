import { expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import { makeV2ThreadPluginFixture } from "./Orchestration.plugin.fixture.ts";
import {
  deleteThreadOrchestrationToolAuth,
  readThreadOrchestrationToolAuth,
  renewThreadOrchestrationToolAuth,
  resolveThreadOrchestrationToolAuthPath,
  writeThreadOrchestrationToolAuth,
} from "../../../orchestration-tools/ThreadOrchestrationToolAuth.ts";

it("old token cleanup/renewal cannot steal a successor, and a current internal token stays usable over long-lived native leases", async () => {
  const app = await makeV2ThreadPluginFixture();
  const owner = { stateDir: app.root, threadId: "owned-token", token: "current-private-token" };
  try {
    await writeThreadOrchestrationToolAuth(owner);
    await writeFile(
      resolveThreadOrchestrationToolAuthPath(owner),
      JSON.stringify({
        threadId: owner.threadId,
        token: owner.token,
        createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      }),
    );
    await renewThreadOrchestrationToolAuth(owner);
    expect(Date.parse((await readThreadOrchestrationToolAuth(owner))!.createdAt)).toBeGreaterThan(
      Date.now() - 1000,
    );
    await writeThreadOrchestrationToolAuth({ ...owner, token: "successor-private-token" });
    await deleteThreadOrchestrationToolAuth(owner);
    expect((await readThreadOrchestrationToolAuth(owner))?.token).toBe("successor-private-token");
    await expect(renewThreadOrchestrationToolAuth(owner)).rejects.toThrow("owner changed");
    await deleteThreadOrchestrationToolAuth({ ...owner, token: "successor-private-token" });
    expect(await readThreadOrchestrationToolAuth(owner)).toBeNull();
    await expect(renewThreadOrchestrationToolAuth(owner)).rejects.toThrow("unavailable");
  } finally {
    await app.close();
  }
});
