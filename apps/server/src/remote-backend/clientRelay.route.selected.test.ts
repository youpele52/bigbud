import { randomUUID } from "node:crypto";
import { WS_METHODS } from "@bigbud/contracts/constants/websocket.constant.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { afterEach, expect, it, vi } from "vitest";
import { buildTestServerConfig } from "../server.test.app.config.ts";
import { activateDevSshOwner } from "../ssh/sshOwnerDevMode.ts";
import { ServerConfig } from "../startup/config.ts";
import {
  RemoteBackendRelayProfiles,
  type ResolvedRemoteBackendRelayProfile,
} from "./clientRelay.profiles.ts";
import { makeRemoteBackendRelayRoute } from "./clientRelay.route.ts";
import type { ClientRelayOwnerExit, ClientRelaySshOwner } from "./clientRelay.ssh.owner.ts";
import { backend, remote } from "./clientRelay.test.helpers.ts";

const legacy = vi.hoisted(() => ({
  ready: vi.fn(),
  trust: vi.fn(),
  build: vi.fn(),
  spawn: vi.fn(),
}));
vi.mock("../ssh/sshVerification.ts", () => ({ assertSshExecutionTargetReadyAsync: legacy.ready }));
vi.mock("../ssh/sshHostTrust.ts", () => ({ inspectSshHostTrust: legacy.trust }));
vi.mock("../ssh/sshCommand.ts", () => ({ buildSshCommandInvocation: legacy.build }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: legacy.spawn,
}));

afterEach(() => {
  for (const call of Object.values(legacy)) {
    expect(call).not.toHaveBeenCalled();
    call.mockClear();
  }
});

const authorityId = "a".repeat(32);
const approved: ResolvedRemoteBackendRelayProfile = {
  profile: {
    profileId: "selected-fixture",
    label: "Selected fixture",
    identity: {
      authority: { authorityId, keyFingerprint: `sha256:${"b".repeat(64)}`, keyEpoch: 1 },
      installationFingerprint: `sha256:${"c".repeat(64)}`,
    },
  },
  executionTargetId: "ssh:host=fixture.invalid&user=viewer&port=2022",
  deployment: {
    authorityId,
    nodeBinary: "/fixture/node",
    nodeSha256: "d".repeat(64),
    helperEntry: "/fixture/client-relay.mjs",
    helperSha256: "e".repeat(64),
  },
};
const caller = { clientId: 1 };

type Route = Effect.Success<ReturnType<typeof makeRemoteBackendRelayRoute>>;

/** Keep the HTTP-server scope open for the whole body; leases belong to it. */
function withRoute<A>(
  owner: ClientRelaySshOwner | undefined,
  body: (route: Route) => Promise<A>,
): Promise<A> {
  return Effect.scoped(
    Effect.gen(function* () {
      const config = yield* buildTestServerConfig({
        config: { mode: "desktop", authToken: "local-control-fixture" },
      });
      const scope = yield* Effect.scope;
      const route = yield* makeRemoteBackendRelayRoute("selected", scope, owner).pipe(
        Effect.provideService(ServerConfig, config),
        Effect.provideService(RemoteBackendRelayProfiles, {
          list: async () => ({ availability: "available", profiles: [approved.profile] }),
          resolve: async () => approved,
        }),
      );
      route.lifecycle.ready(async () => new Set([1]));
      return yield* Effect.promise(() => body(route));
    }),
  ).pipe(Effect.provide(NodeServices.layer), Effect.runPromise);
}

it("does not issue a viewer lease when the selected SSH owner is not bound to the route", async () => {
  activateDevSshOwner();
  await withRoute(undefined, async (route) => {
    const listed = await Effect.runPromise(
      route.handlers[WS_METHODS.serverListRemoteBackendRelayProfiles]({}, caller),
    );
    expect(listed.profiles).toEqual([approved.profile]);

    const open = await Effect.runPromise(
      Effect.result(
        route.handlers[WS_METHODS.serverOpenRemoteBackendRelay](
          { profileId: approved.profile.profileId, requestId: randomUUID() },
          caller,
        ),
      ),
    );
    expect(open).toMatchObject({ _tag: "Failure", failure: { code: "unavailable" } });
  });
});

it("composes the typed owner into the product route without any legacy launch", async () => {
  activateDevSshOwner();
  const upstream = await backend((request, response) =>
    response.end(
      request.headers.authorization === "Bearer private-receiver" ? "relayed" : "denied",
    ),
  );
  const helper = remote(upstream.socketPath, "private-receiver");
  const exit = Promise.withResolvers<ClientRelayOwnerExit>();
  let opened = 0;
  const openClientRelay = vi.fn(async () => {
    opened += 1;
    return {
      stream: helper.stream,
      exit: exit.promise,
      cancel() {
        helper.close();
        exit.resolve({ kind: "exited", code: 0 });
      },
    };
  });
  try {
    await withRoute({ openClientRelay }, async (route) => {
      const lease = await Effect.runPromise(
        route.handlers[WS_METHODS.serverOpenRemoteBackendRelay](
          { profileId: approved.profile.profileId, requestId: randomUUID() },
          caller,
        ),
      );
      expect(openClientRelay).not.toHaveBeenCalled();

      const response = await fetch(lease.baseUrl + "/asset", {
        headers: {
          authorization: `Bearer ${lease.localCredential}`,
          "x-bigbud-client-rpc-revision": "1",
        },
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("relayed");
      expect(opened).toBe(1);
      expect(openClientRelay).toHaveBeenCalledExactlyOnceWith(
        {
          executionTargetId: approved.executionTargetId,
          deployment: approved.deployment,
        },
        expect.any(AbortSignal),
      );

      await Effect.runPromise(
        route.handlers[WS_METHODS.serverCloseRemoteBackendRelay](
          { leaseId: lease.leaseId },
          caller,
        ),
      );
    });
  } finally {
    helper.close();
    await upstream.close();
  }
});
