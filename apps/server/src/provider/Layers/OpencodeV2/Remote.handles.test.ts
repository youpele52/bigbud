import { expect, it, vi } from "vitest";
import type { RemoteAgentWorkspaceClient } from "../../../remote-agent/remoteAgentWorkspaceClient.ts";
import { V2RemoteFiles } from "./Remote.files.ts";

function fixture() {
  const connection = {},
    openWorkspace = vi.fn(async () => ({ accepted: true }));
  const client = {
    connection,
    openWorkspace,
    writeFile: vi.fn(),
  } as unknown as RemoteAgentWorkspaceClient;
  return { client, openWorkspace, resolve: async () => client };
}
it("same-generation owner reopen retains its captured agent root; close revokes locally and remote release is explicitly unsupported", async () => {
  const f = fixture();
  const first = await V2RemoteFiles.open("remote", "/workspace", "owner", f.resolve);
  first.close();
  await expect(first.run({ action: "read", path: "file" })).rejects.toThrow("generation lost");
  const reopened = await V2RemoteFiles.open("remote", "/workspace", "owner", f.resolve);
  expect(f.openWorkspace).toHaveBeenCalledTimes(1);
  await expect(reopened.releaseRemoteHandle()).rejects.toThrow("no workspace-close RPC");
  await expect(reopened.run({ action: "read", path: "file" })).rejects.toThrow();
  const replacement = fixture();
  await V2RemoteFiles.open("remote", "/workspace", "owner", replacement.resolve);
  expect(replacement.openWorkspace).toHaveBeenCalledTimes(1);
});
it("unsupported absent-create is rejected before write dispatch; connection-owned handle budget cannot evict/rebind prior roots", async () => {
  const f = fixture();
  const first = await V2RemoteFiles.open("remote", "/workspace", "owner-0", f.resolve);
  await expect(
    first.run({ action: "write", path: "new", content: "no unsafe create" }),
  ).rejects.toThrow("absent-file CAS");
  expect(f.client.writeFile).not.toHaveBeenCalled();
  await Promise.all(
    Array.from({ length: 63 }, (_, i) =>
      V2RemoteFiles.open("remote", "/workspace", `owner-${i + 1}`, f.resolve),
    ),
  );
  await expect(V2RemoteFiles.open("remote", "/workspace", "owner-64", f.resolve)).rejects.toThrow(
    "no workspace-close capability",
  );
  expect(f.openWorkspace).toHaveBeenCalledTimes(64);
  first.close();
  await V2RemoteFiles.open("remote", "/workspace", "owner-0", f.resolve);
  expect(f.openWorkspace).toHaveBeenCalledTimes(64);
});
it("an unacknowledged open is retained, never automatically resent", async () => {
  const f = fixture();
  f.openWorkspace.mockRejectedValueOnce(new Error("uncertain open"));
  for (let i = 0; i < 2; i++)
    await expect(
      V2RemoteFiles.open("remote", "/workspace", "uncertain", f.resolve),
    ).rejects.toThrow("uncertain open");
  expect(f.openWorkspace).toHaveBeenCalledTimes(1);
});
