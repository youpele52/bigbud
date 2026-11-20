import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Schema } from "effect";
import { build } from "./remoteAgentAdmission.fixtures.ts";
import { makeRemoteAgentRegistryStore } from "./remoteAgentInstall.registry.store.ts";
import { RemoteAgentRegistryV2Schema } from "./remoteAgentInstall.registry.schema.ts";
import {
  buildRemoteAgentRegistryCas,
  buildRemoteAgentRegistryRead,
} from "./remoteAgentInstall.registry.shell.ts";
import {
  pinRemoteAgentBuild,
  reserveRemoteAgentStage,
} from "./remoteAgentInstall.registry.transitions.ts";
import { mobileFixture } from "./remoteAgentInstall.mobile.fixtures.ts";
import {
  reserveRemoteAgentMobileStage,
  setRemoteAgentMobileConsent,
} from "./remoteAgentInstall.mobile.transitions.ts";
import {
  createLinuxControlFixture,
  linuxControlAvailable,
} from "./remoteAgentUpgrade.linux.fixtures.ts";

describe.runIf(linuxControlAvailable)("Linux shared P4/mobile durable CAS", () => {
  let fixture: ReturnType<typeof createLinuxControlFixture>;
  const f = mobileFixture();
  const base = build(1, false);
  beforeAll(async () => {
    if (process.env.BIGBUD_TEST_AGENT_FIXTURES)
      throw new Error("Mobile CAS proof refuses arbitrary fixture volume mounts.");
    const image = process.env.BIGBUD_TEST_MOBILE_CAS_IMAGE;
    if (process.env.BIGBUD_TEST_LINUX_DOCKER === "1" && !image)
      throw new Error("Explicit existing offline mobile CAS image required.");
    fixture = createLinuxControlFixture(image ? { image } : {});
    await fixture.run(`mkdir -p -m 700 '${fixture.root}'`);
  });
  afterAll(() => fixture?.close());

  it("durably upgrades on first mobile write and reconciles an acknowledgement lost after rename", async () => {
    const seed = makeRemoteAgentRegistryStore(fixture.root, fixture);
    await seed.update((state) => reserveRemoteAgentStage(state, "P4-stage", base));
    // An old controller may already have read v2 before the first mobile commit.
    const oldText = Buffer.from(
      (await fixture.run(buildRemoteAgentRegistryRead(fixture.root))).trim(),
      "base64",
    ).toString("utf8");
    const oldState = Schema.decodeUnknownSync(RemoteAgentRegistryV2Schema)(JSON.parse(oldText));
    const staleNext = JSON.stringify({ ...oldState, revision: oldState.revision + 1 });
    let lost = false;
    const store = makeRemoteAgentRegistryStore(fixture.root, {
      run: async (command) => {
        const result = await fixture.run(command);
        if (!lost && command.includes("printf committed")) {
          lost = true;
          throw new Error("fixture lost v3 acknowledgement");
        }
        return result;
      },
    });
    const state = await store.update((before) =>
      setRemoteAgentMobileConsent(before, { ...f.context, expectedConsentRevision: 0 }, true),
    );
    expect(lost).toBe(true);
    expect(state.schemaVersion).toBe(3);
    expect(state.stages[0]?.id).toBe("P4-stage");
    expect(() => Schema.decodeUnknownSync(RemoteAgentRegistryV2Schema)(state)).toThrow();
    expect(
      (
        await fixture.run(
          buildRemoteAgentRegistryCas({ root: fixture.root, expected: oldText, next: staleNext }),
        )
      ).trim(),
    ).toBe("conflict");
    expect(await seed.read()).toEqual(state);
  });

  it("serializes concurrent base pins and mobile intent without dropping either", async () => {
    const first = makeRemoteAgentRegistryStore(fixture.root, fixture);
    const second = makeRemoteAgentRegistryStore(fixture.root, fixture);
    const before = await first.read();
    await Promise.all([
      first.update((state) => reserveRemoteAgentMobileStage(state, f.context, f.request)),
      second.update((state) => pinRemoteAgentBuild(state, "Linux-P4-owner", base.id)),
    ]);
    const state = await first.read();
    expect(state.revision).toBe(before.revision + 2);
    expect(state.pins).toContainEqual({ owner: "Linux-P4-owner", buildId: base.id });
    expect(state.schemaVersion === 3 && state.mobile.stages).toHaveLength(1);
    expect(state.builds).toHaveLength(1);
    expect(state.slotReservations).toHaveLength(0);
  });

  it("fences a stale completion/intent after real competing consent CAS changes", async () => {
    const other = makeRemoteAgentRegistryStore(fixture.root, fixture);
    let injected = false;
    const stale = makeRemoteAgentRegistryStore(fixture.root, {
      run: async (command) => {
        if (!injected && command.includes("printf committed")) {
          injected = true;
          await other.update((state) => setRemoteAgentMobileConsent(state, f.context, false));
          await other.update((state) =>
            setRemoteAgentMobileConsent(state, { ...f.context, expectedConsentRevision: 2 }, true),
          );
        }
        return fixture.run(command);
      },
    });
    await expect(
      stale.update((state) =>
        reserveRemoteAgentMobileStage(state, f.context, { ...f.request, id: "stale-Linux-stage" }),
      ),
    ).rejects.toThrow(/Stale/);
    const state = await other.read();
    expect(injected).toBe(true);
    expect(state.schemaVersion === 3 && state.mobile.consent.revision).toBe(3);
    expect(
      state.schemaVersion === 3 &&
        state.mobile.stages.every((stage) => stage.phase === "cancelled"),
    ).toBe(true);
    expect(state.pins).toContainEqual({ owner: "Linux-P4-owner", buildId: base.id });
  });
});
