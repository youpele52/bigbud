import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  assertV2RemoteLocation,
  resolveV2RemoteLocation,
  v2RemoteLocationIdentity,
} from "./Application.remoteLocation.ts";

const direct = "ssh:host=dev-1&auth=password&transport=direct-ssh";
const agent = "ssh:host=dev-1&auth=password&transport=agent";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function stateDir() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "bigbud-v2-location-")));
  roots.push(root);
  return root;
}

it("keeps the native Location bound under the previous transport after a transport-only switch", async () => {
  const state = await stateDir();
  const original = await resolveV2RemoteLocation(state, "thread", direct, "/root/project");
  expect(path.basename(original)).toBe(v2RemoteLocationIdentity("thread", direct, "/root/project"));
  // Retained binding directory is preferred and the new transport never creates a second Location.
  expect(await resolveV2RemoteLocation(state, "thread", agent, "/root/project", original)).toBe(
    original,
  );
  expect(await resolveV2RemoteLocation(state, "thread", agent, "/root/project")).toBe(original);
  expect(await fs.readdir(path.dirname(original))).toEqual([path.basename(original)]);
  await expect(
    assertV2RemoteLocation(state, "thread", agent, "/root/project", original),
  ).resolves.toBeUndefined();
  await expect(
    assertV2RemoteLocation(state, "thread", direct, "/root/project", original),
  ).resolves.toBeUndefined();
});

it("still rejects a Location from another host, root or thread", async () => {
  const state = await stateDir();
  const original = await resolveV2RemoteLocation(state, "thread", direct, "/root/project");
  const otherHost = "ssh:host=dev-2&auth=password&transport=agent";
  await expect(
    assertV2RemoteLocation(state, "thread", otherHost, "/root/project", original),
  ).rejects.toThrow("conflicts");
  await expect(
    assertV2RemoteLocation(state, "thread", agent, "/root/other", original),
  ).rejects.toThrow("conflicts");
  await expect(
    assertV2RemoteLocation(state, "other-thread", agent, "/root/project", original),
  ).rejects.toThrow("conflicts");
  expect(await resolveV2RemoteLocation(state, "thread", otherHost, "/root/project")).not.toBe(
    original,
  );
});

it("resolves a Location created under the legacy bare-host form after switching transport", async () => {
  const state = await stateDir();
  const original = await resolveV2RemoteLocation(state, "thread", "ssh:dev-1", "/root/project");
  const next = "ssh:host=dev-1&transport=agent";
  expect(await resolveV2RemoteLocation(state, "thread", next, "/root/project")).toBe(original);
  await expect(
    assertV2RemoteLocation(state, "thread", next, "/root/project", original),
  ).resolves.toBeUndefined();
});
