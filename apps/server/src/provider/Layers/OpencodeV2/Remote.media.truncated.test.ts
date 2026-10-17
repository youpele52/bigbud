import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { MessageId, ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";
import { makeV2RemoteAgentFixture } from "./Remote.fixture.ts";
import { V2RemoteFiles } from "./Remote.files.ts";
import { prepareV2RemoteMedia } from "./Remote.media.ts";

for (const kind of ["truncated", "totalBytes", "length"] as const)
  it(`real remote workspace client rejects ${kind} attachment snapshots without concatenation or host fallback`, async () => {
    await withV2RuntimeFixture(async ({ runtime, directory }) => {
      await writeFile(path.join(directory, "reference.txt"), "remote snapshot");
      const agent = await makeV2RemoteAgentFixture(directory, runtime.options.config.profileRoot);
      const request = agent.client.connection.request.bind(agent.client.connection);
      vi.spyOn(agent.client.connection, "request").mockImplementation(async (...args) => {
        const frame = await request(...args);
        if (frame.type !== "readFileResponse") return frame;
        return {
          ...frame,
          value: {
            ...frame.value,
            ...(kind === "truncated" ? { truncated: true } : {}),
            ...(kind === "totalBytes" ? { totalBytes: frame.value.bytes.length + 1 } : {}),
            ...(kind === "length" ? { bytes: Buffer.from(""), totalBytes: 1 } : {}),
          },
        };
      });
      const remote = await V2RemoteFiles.open(
        "agent:truncated",
        directory,
        `snapshot-${kind}`,
        async () => agent.client,
      );
      try {
        await expect(
          prepareV2RemoteMedia(
            {
              threadId: ThreadId.makeUnsafe("remote-incomplete"),
              requestMessageId: MessageId.makeUnsafe(`incomplete-${kind}`),
              input: "read snapshot",
              attachments: [
                {
                  type: "path",
                  id: "ref",
                  name: "reference.txt",
                  path: "reference.txt",
                  entryKind: "file",
                  sizeBytes: 0,
                  mimeType: "text/plain",
                },
              ],
            },
            remote,
          ),
        ).rejects.toThrow("incomplete");
        expect(agent.requests.filter((frame) => frame.type === "readFileRequest")).toHaveLength(1);
        expect(agent.requests.some((frame) => frame.type === "writeFileRequest")).toBe(false);
      } finally {
        remote.close();
      }
    });
  });
