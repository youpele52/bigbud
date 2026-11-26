import { ServerListRemoteFoldersError } from "@bigbud/contracts/server/server.remoteFolders";
import { Effect } from "effect";
import { expect, it, vi } from "vitest";

import { listRemoteFoldersEffect } from "./wsRemoteFolders.ts";

const legacyList = vi.hoisted(() =>
  vi.fn<typeof import("../ssh/sshRemoteFolders.ts").listRemoteFolders>(),
);
vi.mock(import("../ssh/sshRemoteFolders.ts"), () => ({ listRemoteFolders: legacyList }));

const input = { executionTargetId: "ssh:fixture", path: "~/fixture" };

it("keeps the legacy runner argument untouched when adding routed cancellation", async () => {
  const result = { path: "/fixture", homePath: "/", folders: [], truncated: false };
  legacyList.mockResolvedValueOnce(result);
  await expect(Effect.runPromise(listRemoteFoldersEffect(input))).resolves.toEqual(result);
  expect(legacyList).toHaveBeenCalledExactlyOnceWith(input);
});

it("preserves an already typed owner-unavailable error with its discriminator", async () => {
  const error = new ServerListRemoteFoldersError({
    message: "The development SSH owner failed to start.",
    code: "sshOwnerUnavailable",
  });
  const result = await Effect.runPromise(
    listRemoteFoldersEffect(input, async () => {
      throw error;
    }).pipe(Effect.flip),
  );
  expect(result).toBe(error);
});
