import { expect, it, vi } from "vitest";
import type { OpencodeV2Client } from "./Client.ts";
import { readV2NativeActivity } from "./PluginSetup.activity.ts";
import { deferred } from "./Test.fixtures.ts";

it("reads only bounded public activity, drops commands/metadata and reports busy independently of local enrollment expiry", async () => {
  const client = {
    session: { active: vi.fn(async () => ({ ses_other_actor: { type: "running" } })) },
    debug: { location: { list: vi.fn(async () => [{ directory: "/A" }, { directory: "/B" }]) } },
    shell: {
      list: vi.fn(async ({ location }: { location: { directory: string } }) => ({
        location,
        data: [
          {
            id: "shell-owned",
            status: location.directory === "/B" ? "running" : "exited",
            command: "DO NOT RETAIN THIS COMMAND",
            metadata: { private: "DO NOT RETAIN METADATA" },
          },
        ],
      })),
    },
  } as unknown as OpencodeV2Client;
  const result = await readV2NativeActivity(client, () => {}, new AbortController().signal);
  expect(result).toEqual({ foregroundCount: 1, runningShellCount: 1, directories: ["/A", "/B"] });
  expect(JSON.stringify(result)).not.toMatch(/COMMAND|METADATA|shell-owned/);
});

it("unknown/overflow/late revoked API evidence is never empty-idle proof", async () => {
  const locationList = vi.fn(async () =>
    Array.from({ length: 65 }, (_, n) => ({ directory: `/owned/${n}` })),
  );
  const client = {
    session: { active: async () => ({}) },
    debug: { location: { list: locationList } },
    shell: { list: vi.fn() },
  } as unknown as OpencodeV2Client;
  const controller = new AbortController();
  await expect(readV2NativeActivity(client, () => {}, controller.signal)).rejects.toThrow(
    "unknown/over its bound",
  );
  expect(client.shell.list).not.toHaveBeenCalled();
  const entered = deferred<void>(),
    held = deferred<Array<{ directory: string }>>();
  locationList.mockImplementation(async () => {
    entered.resolve();
    return held.promise;
  });
  const pending = readV2NativeActivity(
    client,
    () => controller.signal.throwIfAborted(),
    controller.signal,
  );
  const rejected = expect(pending).rejects.toThrow();
  await entered.promise;
  controller.abort();
  held.resolve([]);
  await rejected;
  expect(client.shell.list).not.toHaveBeenCalled();
});
