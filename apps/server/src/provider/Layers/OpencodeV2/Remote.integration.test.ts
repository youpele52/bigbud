import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";
import { makeV2RemoteAgentFixture } from "./Remote.fixture.ts";
import { V2RemoteFiles } from "./Remote.files.ts";

it("remote workspace client generation cannot rebind writes; absent-file CAS and path escapes are truthful unsupported", async () => {
  await withV2RuntimeFixture(async ({ runtime, directory }) => {
    const profile = await realpath(runtime.options.config.profileRoot),
      root = await realpath(directory);
    await mkdir(path.join(root, "sub"));
    const agent = await makeV2RemoteAgentFixture(root, profile);
    let client = agent.client;
    const files = await V2RemoteFiles.open("ssh:synthetic", root, "generation", async () => client);
    await expect(
      files.run({ action: "write", path: "new.txt", content: "wrong", expectedSha256: null }),
    ).rejects.toThrow("absent-file CAS");
    await expect(files.run({ action: "read", path: "../secret" })).rejects.toThrow("escapes");
    client = (await makeV2RemoteAgentFixture(root, profile)).client;
    await expect(
      files.run({
        action: "edit",
        path: "old.txt",
        content: "wrong",
        expectedSha256: agent.sha("old"),
      }),
    ).rejects.toThrow("generation lost");
    expect(agent.requests.some((frame) => frame.type === "writeFileRequest")).toBe(false);
  });
});
