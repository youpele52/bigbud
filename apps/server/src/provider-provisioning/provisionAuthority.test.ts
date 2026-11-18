import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as Path from "node:path";

import { WS_METHODS } from "@bigbud/contracts/constants/websocket.constant.ts";
import { WsRpcGroup } from "@bigbud/contracts";
import { MobileWsRpcGroup } from "@bigbud/contracts/server/rpc.mobile";
import { ProviderProvisioningSetupAuthority } from "@bigbud/contracts/server/rpc.providerProvisioning.ts";
import { Effect, Exit } from "effect";
import { Headers } from "effect/unstable/http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { provisionProvider } from "./provision.ts";
import { makeEnvironment } from "./provision.test.helpers.ts";
import {
  grantsProviderProvisioning,
  makeProviderProvisioningAuthority,
  type ProvisioningConnection,
} from "./provisionAuthority.ts";

const laptop: ProvisioningConnection = {
  mode: "remote",
  remoteClientRouter: true,
  authorized: true,
  trustedLocal: true,
};
const viewer: ProvisioningConnection = { ...laptop, remoteClientRouter: false };
const header = "x-bigbud-provider-provisioning-authority";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(Path.join(tmpdir(), "bigbud-provision-authority-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Runs the Copilot provision action behind the route's middleware, as the WS RPC server does. */
function provisionCopilotAs(
  authority: ReturnType<typeof makeProviderProvisioningAuthority>,
  headers: Headers.Headers,
) {
  const fixture = makeEnvironment({ dir });
  const run = Effect.gen(function* () {
    const middleware = yield* ProviderProvisioningSetupAuthority;
    const action = provisionProvider("copilot", fixture.environment);
    return yield* Effect.exit(middleware(action as never, { headers } as never));
  }).pipe(Effect.provide(authority.layer), Effect.scoped);
  return { fixture, run };
}

describe("provider provisioning authority", () => {
  it("remote mode needs setup authority; desktop/web keep the trusted local path", () => {
    expect(grantsProviderProvisioning(laptop)).toBe(true);
    expect(grantsProviderProvisioning(viewer)).toBe(false);
    expect(grantsProviderProvisioning({ ...laptop, authorized: false })).toBe(false);
    expect(grantsProviderProvisioning({ ...viewer, mode: "desktop" })).toBe(true);
    expect(grantsProviderProvisioning({ ...viewer, mode: "web", trustedLocal: false })).toBe(false);
  });

  it("Copilot provisions under setup authority and is refused for a viewer", async () => {
    const authority = makeProviderProvisioningAuthority("capability-under-test");

    const granted = provisionCopilotAs(
      authority,
      authority.authorizeHeaders(Headers.empty, laptop),
    );
    const allowed = await Effect.runPromise(granted.run);
    expect(Exit.isSuccess(allowed)).toBe(true);
    if (Exit.isSuccess(allowed)) expect(allowed.value).toMatchObject({ outcome: "installing" });
    expect(granted.fixture.install).toHaveBeenCalledTimes(1);

    // A viewer forging the header (even with the right value) is stripped and denied.
    const forged = authority.authorizeHeaders(
      Headers.fromInput({ [header]: "capability-under-test" }),
      viewer,
    );
    const refused = provisionCopilotAs(authority, forged);
    const denied = await Effect.runPromise(refused.run);
    expect(Exit.isFailure(denied)).toBe(true);
    expect(String(Exit.isFailure(denied) ? denied.cause : "")).toMatch(/unauthorized/);
    expect(refused.fixture.install).not.toHaveBeenCalled();
    expect(refused.fixture.status).not.toHaveBeenCalled();

    // A capability from another route instance does not match.
    const other = makeProviderProvisioningAuthority();
    const foreign = provisionCopilotAs(authority, other.authorizeHeaders(Headers.empty, laptop));
    expect(Exit.isFailure(await Effect.runPromise(foreign.run))).toBe(true);
    expect(foreign.fixture.install).not.toHaveBeenCalled();
  });

  it("only the provision action needs authority, and mobile has neither RPC", () => {
    const provision = WsRpcGroup.requests.get(WS_METHODS.serverProvisionProvider);
    const status = WsRpcGroup.requests.get(WS_METHODS.serverGetProviderProvisioningStatus);
    expect(provision?.middlewares.has(ProviderProvisioningSetupAuthority as never)).toBe(true);
    expect(status).toBeDefined();
    for (const method of [
      WS_METHODS.serverProvisionProvider,
      WS_METHODS.serverGetProviderProvisioningStatus,
    ]) {
      expect(MobileWsRpcGroup.requests.has(method)).toBe(false);
    }
  });
});
