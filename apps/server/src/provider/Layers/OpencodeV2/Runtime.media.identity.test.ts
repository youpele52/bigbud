import { expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { MessageId, ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { prepareV2Media } from "./Runtime.media.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});

it.skipIf(process.platform === "win32")(
  "rejects deterministic intermediate replacement before reading a foreign opened object",
  async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const root = await actual.realpath(
      await actual.mkdtemp(path.join(os.tmpdir(), "v2-media-identity-")),
    );
    const outside = await actual.realpath(
      await actual.mkdtemp(path.join(os.tmpdir(), "v2-media-outside-")),
    );
    const directory = path.join(root, "media");
    const filename = path.join(directory, "media.txt");
    let opened: fs.FileHandle | undefined;
    try {
      await actual.mkdir(directory, { mode: 0o700 });
      await actual.writeFile(filename, "permitted bytes", { mode: 0o600 });
      await actual.writeFile(path.join(outside, "media.txt"), "foreign synthetic bytes", {
        mode: 0o600,
      });
      vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
        await actual.rename(directory, `${directory}.original`);
        await actual.symlink(outside, directory, "dir");
        const handle = await actual.open(...args);
        opened = handle;
        vi.spyOn(handle, "read");
        return handle;
      });
      await expect(
        prepareV2Media(
          {
            threadId: ThreadId.makeUnsafe("media"),
            requestMessageId: MessageId.makeUnsafe("media"),
            input: "synthetic",
            attachments: [
              {
                type: "file",
                id: "media",
                name: "file.txt",
                sourcePath: filename,
                mimeType: "text/plain",
                sizeBytes: 15,
              },
            ],
          },
          root,
          directory,
        ),
      ).rejects.toThrow("identity changed");
      expect(opened?.read).not.toHaveBeenCalled();
    } finally {
      vi.mocked(fs.open).mockReset();
      await actual.rm(root, { recursive: true, force: true });
      await actual.rm(outside, { recursive: true, force: true });
    }
  },
);
