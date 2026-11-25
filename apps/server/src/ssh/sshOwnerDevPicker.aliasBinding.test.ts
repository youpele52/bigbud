import { describe, expect, it, vi } from "vitest";

import { makeSshOwnerDevPicker } from "./sshOwnerDevPicker.ts";
import type { PickerProofOwner } from "./sshOwnerPickerProof.client.session.ts";

const input = { executionTargetId: "ssh:host=workbench&auth=ssh-key&transport=direct-ssh" };
const folders = { path: "/w", homePath: "/w", folders: [], truncated: false };
const saved = new Uint8Array(32).fill(1);
const changed = new Uint8Array(32).fill(2);

function fixture(descriptor: Uint8Array | undefined) {
  const approved = new Map<string, Uint8Array>();
  const key = "profile";
  const binding = {
    check: vi.fn(async (value: Uint8Array) => {
      const current = approved.get(key);
      if (!current) return "unbound" as const;
      return Buffer.from(current).equals(value) ? ("match" as const) : ("changed" as const);
    }),
    approve: vi.fn(async (value: Uint8Array, mode: "firstUse" | "reapprove") => {
      if (mode === "reapprove" || !approved.has(key)) approved.set(key, Uint8Array.from(value));
      return binding.check(value);
    }),
  };
  const client = {
    aliasDescriptor: descriptor,
    listRemoteFolders: vi.fn<PickerProofOwner["listRemoteFolders"]>().mockResolvedValue(folders),
    listAliases: vi
      .fn<PickerProofOwner["listAliases"]>()
      .mockResolvedValue({ entries: [], truncated: false, maxEntries: 256 }),
    inspectTrust: vi.fn<PickerProofOwner["inspectTrust"]>(),
    approveTrust: vi.fn<PickerProofOwner["approveTrust"]>(),
    connect: vi.fn<PickerProofOwner["connect"]>().mockResolvedValue({ state: "connected" }),
    disconnect: vi
      .fn<PickerProofOwner["disconnect"]>()
      .mockResolvedValue({ state: "disconnected" }),
    close: vi.fn<PickerProofOwner["close"]>().mockResolvedValue(undefined),
  };
  const picker = makeSshOwnerDevPicker({
    ...input,
    host: "workbench",
    aliasBinding: binding,
    startOwner: async () => client,
  });
  return { approved, binding, client, picker };
}

describe("development SSH picker saved-alias rule", () => {
  it("binds on save, refuses a changed descriptor without an owner request, and re-approves only on Connect", async () => {
    const first = fixture(saved);
    await first.picker.verifyExecutionTarget({ ...input, cwd: "/w" });
    expect(first.approved.get("profile")).toEqual(saved);
    await first.picker.close();

    const next = fixture(changed);
    next.approved.set("profile", saved);
    await expect(next.picker.listRemoteFolders(input)).rejects.toMatchObject({
      code: "sshAliasChanged",
    });
    // A save cannot silently replace the approved descriptor either.
    await expect(next.picker.verifyExecutionTarget({ ...input, cwd: "/w" })).rejects.toThrow(
      /changed since this workspace was saved/,
    );
    await expect(next.picker.inspectTrust(input)).rejects.toThrow(/changed since/);
    expect(next.client.listRemoteFolders).not.toHaveBeenCalled();
    expect(next.client.inspectTrust).not.toHaveBeenCalled();
    expect(next.approved.get("profile")).toEqual(saved);

    await next.picker.connectExecutionTarget(input);
    expect(next.approved.get("profile")).toEqual(changed);
    await expect(next.picker.listRemoteFolders(input)).resolves.toEqual(folders);
    await next.picker.close();
  });

  it("does not re-approve on Connect unless the change was presented, and fails closed without a descriptor", async () => {
    const quiet = fixture(changed);
    quiet.approved.set("profile", saved);
    await quiet.picker.connectExecutionTarget(input);
    expect(quiet.approved.get("profile")).toEqual(saved);
    await quiet.picker.close();

    const missing = fixture(undefined);
    await expect(missing.picker.listRemoteFolders(input)).rejects.toMatchObject({
      code: "sshConfigUnsupported",
    });
    expect(missing.client.listRemoteFolders).not.toHaveBeenCalled();
    await missing.picker.close();
  });
});
