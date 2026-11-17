import { WS_METHODS } from "@bigbud/contracts/constants/websocket.constant.ts";
import { WsRpcGroup } from "@bigbud/contracts";
import { MobileWsRpcGroup } from "@bigbud/contracts/server/rpc.mobile";
import { RemoteRuntimeUpdateSetupAuthority } from "@bigbud/contracts/server/rpc.remoteBackendUpdate.ts";
import { assert, it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { Headers } from "effect/unstable/http";
import {
  grantsRuntimeUpdateSetupAuthority,
  makeRuntimeUpdateSetupAuthority,
  type RuntimeUpdateConnection,
} from "./runtimeUpdate.authority.ts";

const UPDATE_METHODS = [
  WS_METHODS.serverRequestRemoteRuntimeUpdate,
  WS_METHODS.serverGetRemoteRuntimeUpdateStatus,
  WS_METHODS.serverConsentRemoteRuntimeUpdateInterruption,
  WS_METHODS.serverCancelRemoteRuntimeUpdate,
];
const laptop: RuntimeUpdateConnection = {
  mode: "remote",
  remoteClientRouter: true,
  authorized: true,
};
const header = "x-bigbud-remote-runtime-update-authority";

const runThroughMiddleware = (
  authority: ReturnType<typeof makeRuntimeUpdateSetupAuthority>,
  headers: Headers.Headers,
) =>
  Effect.gen(function* () {
    const middleware = yield* RemoteRuntimeUpdateSetupAuthority;
    return yield* Effect.exit(middleware(Effect.succeed("reached") as never, { headers } as never));
  }).pipe(Effect.provide(authority.layer));

it("grants setup authority only to the authenticated remote client socket", () => {
  assert.isTrue(grantsRuntimeUpdateSetupAuthority(laptop));
  // Paired mobile viewers never come through the client socket router.
  assert.isFalse(grantsRuntimeUpdateSetupAuthority({ ...laptop, remoteClientRouter: false }));
  assert.isFalse(grantsRuntimeUpdateSetupAuthority({ ...laptop, authorized: false }));
  // The local desktop/web backend is not a remote backend.
  assert.isFalse(grantsRuntimeUpdateSetupAuthority({ ...laptop, mode: "desktop" }));
  assert.isFalse(grantsRuntimeUpdateSetupAuthority({ ...laptop, mode: "web" }));
});

it.effect("viewer_connection_denied_server_side", () =>
  Effect.gen(function* () {
    const authority = makeRuntimeUpdateSetupAuthority("capability-under-test");
    // A viewer that forges the capability header (even with the right value) is stripped.
    const forged = authority.authorizeHeaders(
      Headers.fromInput({ [header]: "capability-under-test" }),
      { ...laptop, remoteClientRouter: false },
    );
    const denied = yield* runThroughMiddleware(authority, forged);
    assert.isTrue(Exit.isFailure(denied));
    if (Exit.isFailure(denied)) assert.match(String(denied.cause), /unauthorized/);
    const granted = yield* runThroughMiddleware(
      authority,
      authority.authorizeHeaders(Headers.empty, laptop),
    );
    assert.deepStrictEqual(granted, Exit.succeed("reached" as never));
    // A capability from another route instance does not match.
    const other = makeRuntimeUpdateSetupAuthority();
    const foreign = yield* runThroughMiddleware(
      authority,
      other.authorizeHeaders(Headers.empty, laptop),
    );
    assert.isTrue(Exit.isFailure(foreign));
  }),
);

it("mobile cannot reach the update RPCs and every update RPC requires setup authority", () => {
  for (const method of UPDATE_METHODS) {
    assert.isFalse(MobileWsRpcGroup.requests.has(method), `${method} is on the mobile group`);
    const rpc = WsRpcGroup.requests.get(method);
    assert.isDefined(rpc, `${method} is not registered`);
    assert.isTrue(rpc!.middlewares.has(RemoteRuntimeUpdateSetupAuthority as never));
  }
});
