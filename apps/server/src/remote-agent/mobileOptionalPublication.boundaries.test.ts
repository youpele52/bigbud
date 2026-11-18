import {
  publicationFixture,
  publicationWiring,
} from "./mobileOptionalPublication.test-fixtures.ts";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, expect, it } from "vitest";
import { revalidateMobileOptionalPublication } from "./mobileOptionalPublication.ts";

const fixtures: Awaited<ReturnType<typeof publicationFixture>>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});
async function fixture() {
  const f = await publicationFixture();
  fixtures.push(f);
  return f;
}
function nextState(script: string) {
  const encoded = script.match(
    /printf '%s' '([A-Za-z0-9+/=]+)' \| base64 --decode > "\$next"/,
  )?.[1];
  return encoded ? JSON.parse(Buffer.from(encoded, "base64").toString()) : undefined;
}

it("ordinary settled close releases the lease and permits fresh verified reacquisition", async () => {
  const f = await fixture();
  const old = await f.run((publisher) => publisher.publish(f.request));
  await expect(revalidateMobileOptionalPublication(old)).rejects.toThrow(/authority/);
  await f.run(async (publisher) => {
    const proof = await publisher.remint(f.request.stageId, f.request.consentRevision);
    expect((await revalidateMobileOptionalPublication(proof)).stageId).toBe(f.request.stageId);
  });
});

it("releases a registered authority if subscription construction fails before work starts", async () => {
  const f = await fixture();
  await expect(
    f.run(async () => "must not begin", {
      settings: {
        ...f.settings,
        onSnapshotChange: () => {
          throw new Error("fixture subscription construction failed");
        },
      },
    }),
  ).rejects.toThrow();
  expect(await f.run(async () => "authority reacquired")).toBe("authority reacquired");
});

it("revocation invalidates immediately but retains writer lease until paused work settles", async () => {
  const f = await fixture();
  let resumed!: () => void, observed!: () => void;
  const gate = new Promise<void>((resolve) => {
    resumed = resolve;
  });
  const paused = new Promise<void>((resolve) => {
    observed = resolve;
  });
  let intercepted = false;
  publicationWiring.before = async (script) => {
    if (!intercepted && nextState(script)?.mobile?.stages?.[0]?.phase === "publication-writing") {
      intercepted = true;
      observed();
      await gate;
    }
  };
  const first = f
    .run((publisher) => publisher.publish(f.request))
    .then(
      () => null,
      (error: unknown) => error,
    );
  await paused;
  try {
    await Effect.runPromise(f.settings.updateSettings({ mobileRemoteControl: { enabled: false } }));
    await Effect.runPromise(f.settings.updateSettings({ mobileRemoteControl: { enabled: true } }));
    await expect(
      f.run(async () => "must not acquire while first writer is paused"),
    ).rejects.toThrow(/lease/);
  } finally {
    resumed();
    await first;
  }
  expect(await f.run(async () => "reacquired after settling")).toBe("reacquired after settling");
});

it("preserves an unclaimed directory after mkdir-before-intent failure as repair-required", async () => {
  const f = await fixture();
  let intercepted = false;
  publicationWiring.before = async (script) => {
    if (!intercepted && nextState(script)?.mobile?.stages?.[0]?.phase === "publication-writing") {
      intercepted = true;
      throw new Error("fixture fails before directory intent CAS");
    }
  };
  await expect(f.run((publisher) => publisher.publish(f.request))).rejects.toThrow();
  publicationWiring.before = undefined;
  const namespace = join(f.control.root, "components-v1");
  const names = await fs.readdir(namespace);
  expect(names).toHaveLength(1);
  expect(await fs.readdir(join(namespace, names[0]!))).toEqual([]);
  await expect(f.run((publisher) => publisher.publish(f.request))).rejects.toMatchObject({
    cause: { _tag: "MobilePublicationRepairRequired" },
  });
  expect(await fs.readdir(namespace)).toEqual(names);
});

it("rejects same-byte inode substitution and cannot launder it through remint", async () => {
  const f = await fixture();
  await f.run(async (publisher) => {
    const proof = await publisher.publish(f.request);
    const paths = await revalidateMobileOptionalPublication(proof);
    await fs.rename(paths.gatewayPath, paths.gatewayPath + ".old");
    await fs.writeFile(paths.gatewayPath, f.request.gatewayBytes, { flag: "wx", mode: 0o700 });
    await fs.unlink(paths.gatewayPath + ".old");
    await expect(revalidateMobileOptionalPublication(proof)).rejects.toThrow(/substituted/);
    await expect(publisher.remint(f.request.stageId, 1)).rejects.toThrow(/substituted/);
  });
});

it("refuses links and non-private permissions in a published component", async () => {
  const f = await fixture();
  await f.run(async (publisher) => {
    const proof = await publisher.publish(f.request);
    const paths = await revalidateMobileOptionalPublication(proof);
    await fs.chmod(paths.assetsArchivePath, 0o644);
    await expect(revalidateMobileOptionalPublication(proof)).rejects.toThrow(/private/);
    await fs.chmod(paths.assetsArchivePath, 0o600);
    await fs.link(paths.gatewayPath, join(f.home, "linked-gateway"));
    await expect(revalidateMobileOptionalPublication(proof)).rejects.toThrow(/regular/);
  });
});

it("settles accepted paused IO before outer backend ownership is released on interruption", async () => {
  const f = await fixture();
  const controller = new AbortController();
  let resumed!: () => void, observed!: () => void;
  const gate = new Promise<void>((resolve) => {
    resumed = resolve;
  });
  const paused = new Promise<void>((resolve) => {
    observed = resolve;
  });
  let intercepted = false,
    settled = false,
    released = false;
  publicationWiring.before = async (script) => {
    if (!intercepted && nextState(script)?.mobile?.stages?.[0]?.phase === "publication-writing") {
      intercepted = true;
      observed();
      await gate;
    }
  };
  const outcome = f
    .run((publisher) => publisher.publish(f.request), {
      signal: controller.signal,
      onExit: async () => {
        released = true;
        await f.releaseOwner();
      },
    })
    .then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
  await paused;
  controller.abort();
  await new Promise((resolve) => setImmediate(resolve));
  expect(settled).toBe(false);
  expect(released).toBe(false);
  await f.owner().assertHeld();
  resumed();
  await outcome;
  expect(released).toBe(true);
});

it("preserves partial or foreign members instead of overwriting or reporting publication", async () => {
  const f = await fixture();
  let partialPath: string | undefined;
  publicationWiring.before = async () => {
    const state = f.read();
    const intent = state.schemaVersion === 3 && state.mobile.stages[0]?.publicationIntent;
    if (!intent || partialPath) return;
    const directory = join(f.control.root, "components-v1", intent.key);
    try {
      await fs.lstat(join(directory, "gateway"));
    } catch {
      return;
    }
    partialPath = join(directory, "assets.tar.gz");
    await fs.writeFile(partialPath, "unknown partial bytes", { flag: "wx", mode: 0o600 });
  };
  await expect(f.run((publisher) => publisher.publish(f.request))).rejects.toThrow();
  expect(partialPath).toBeDefined();
  expect(await fs.readFile(partialPath!, "utf8")).toBe("unknown partial bytes");
  const state = f.read();
  expect(state.schemaVersion === 3 && state.mobile.stages[0]?.phase).toBe("publication-writing");
  expect(state.schemaVersion === 3 && state.mobile.stages[0]?.publicationReceipt).toBeUndefined();
});

it("reconciles lost final CAS acknowledgement without replacing immutable files", async () => {
  const f = await fixture();
  let injected = false;
  publicationWiring.before = async (script) => {
    if (!injected && nextState(script)?.mobile?.stages?.[0]?.phase === "files-published") {
      injected = true;
      f.command().loseNextAck();
    }
  };
  await f.run(async (publisher) => {
    const proof = await publisher.publish(f.request);
    expect(injected).toBe(true);
    expect((await revalidateMobileOptionalPublication(proof)).stageId).toBe(f.request.stageId);
  });
});

it("signal-less public proof revalidation cannot race publisher retirement", async () => {
  const f = await fixture();
  await f.run(async (publisher) => {
    const proof = await publisher.publish(f.request);
    let retired = false;
    publicationWiring.before = async () => {
      if (retired) return;
      retired = true;
      await Effect.runPromise(
        f.settings.updateSettings({ mobileRemoteControl: { enabled: false } }),
      );
      await Effect.runPromise(
        f.settings.updateSettings({ mobileRemoteControl: { enabled: true } }),
      );
    };
    await expect(revalidateMobileOptionalPublication(proof)).rejects.toThrow(/authority|revoked/);
    expect(retired).toBe(true);
  });
});

it("remints only after prior controller death, with full signed file rechecks", async () => {
  const f = await fixture();
  await f.run((publisher) => publisher.publish(f.request));
  await f.restart(false);
  await expect(f.run((publisher) => publisher.remint(f.request.stageId, 1))).rejects.toThrow();
  await f.restart(true);
  await f.run(async (publisher) => {
    const proof = await publisher.remint(f.request.stageId, 1);
    const paths = await revalidateMobileOptionalPublication(proof);
    expect(paths.controller.id).not.toBe(paths.publicationController.id);
    expect(await fs.readFile(paths.gatewayPath)).toEqual(f.request.gatewayBytes);
  });
});
