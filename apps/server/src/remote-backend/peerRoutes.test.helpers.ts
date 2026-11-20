import { generateKeyPairSync } from "node:crypto";

import { CommandId, ProjectId } from "@bigbud/contracts";
import { PEER_CREDENTIAL_HEADERS } from "@bigbud/contracts/constants/remotePeer.constant.ts";
import type { PeerGrant } from "@bigbud/contracts/server/remotePeer.ts";
import { Effect, Exit, Layer, Scope } from "effect";
import { HttpRouter } from "effect/unstable/http";

import { createOrchestrationSystem } from "../orchestration/Layers/OrchestrationEngine.test.helpers.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import {
  COORDINATOR_AUTHORITY,
  WORKER_AUTHORITY,
  peerGrantFixture,
  peerUuid,
} from "../peer-orchestration/peerFixtures.test.helpers.ts";
import { makePeerChildStarter } from "../peer-orchestration/peerWorker.start.ts";
import { PeerChildStarterService } from "../peer-orchestration/peerWorker.starter.layer.ts";
import { PeerChildRepositoryLive } from "../persistence/Layers/PeerChildren.ts";
import { PeerGrantRepositoryLive } from "../persistence/Layers/PeerGrants.ts";
import { PeerChildRepository } from "../persistence/Services/PeerChildren.ts";
import { PeerGrantRepository } from "../persistence/Services/PeerGrants.ts";
import { RemoteBackendIdentityService } from "./identity.service.ts";
import { remotePeerRoutesLayer } from "./peerRoutes.ts";

export const WORKSPACE = "/srv/work";
export const LOCAL_CEILING = {
  runtimeMode: "full-access",
  providers: ["codex", "claudeAgent"],
  workspaceRoots: [WORKSPACE, "/srv/other", "/srv/missing"],
} as const satisfies PeerGrant["ceiling"];

export const peerHeaders = (grant: PeerGrant) => ({
  [PEER_CREDENTIAL_HEADERS.grant]: grant.grantId,
  [PEER_CREDENTIAL_HEADERS.coordinator]: grant.coordinatorAuthorityId,
  [PEER_CREDENTIAL_HEADERS.keyFingerprint]: grant.coordinatorKeyFingerprint,
});

export const delegateBody = (n: number, overrides: Record<string, unknown> = {}) => ({
  dispatchId: peerUuid(2, n),
  coordinatorThreadId: "thread-coordinator",
  workspaceRoot: WORKSPACE,
  provider: "codex",
  permissions: {
    runtimeMode: "approval-required",
    providers: ["codex"],
    workspaceRoots: [WORKSPACE],
  },
  title: `Delegated ${n}`,
  task: `Do task ${n}.`,
  ...overrides,
});

/** JSON POST (or GET) against a web handler; plain-text replies stay text. */
export function makePoster(app: { readonly handler: (request: Request) => Promise<Response> }) {
  return async (
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
    method = "POST",
  ) => {
    const response = await app.handler(
      new Request(`http://peer.invalid${path}`, {
        method,
        headers: { "content-type": "application/json", ...headers },
        ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
      }),
    );
    const text = await response.text();
    let json: unknown = text;
    try {
      json = JSON.parse(text);
    } catch {
      // Plain-text refusals stay as text.
    }
    return { status: response.status, json: json as any };
  };
}

/** A real orchestration engine on in-memory SQLite plus the peer router as a web handler. */
export async function makePeerRouteFixture() {
  const system = await createOrchestrationSystem();
  await system.run(
    system.engine.dispatch({
      type: "project.create",
      commandId: CommandId.makeUnsafe("peer-project-create"),
      projectId: ProjectId.makeUnsafe("peer-project"),
      title: "Peer project",
      workspaceRoot: WORKSPACE,
      defaultModelSelection: { provider: "codex", model: "gpt-5-codex" },
      createdAt: new Date().toISOString(),
    }),
  );
  const repositories = await system.runSql(
    Effect.gen(function* () {
      return { grants: yield* PeerGrantRepository, children: yield* PeerChildRepository };
    }).pipe(Effect.provide(Layer.mergeAll(PeerGrantRepositoryLive, PeerChildRepositoryLive))),
  );
  const starterScope = await system.run(Scope.make());
  const starter = await system.run(
    makePeerChildStarter({ engine: system.engine, children: repositories.children }).pipe(
      Scope.provide(starterScope),
    ),
  );
  const { publicKey } = generateKeyPairSync("ed25519");
  const services = Layer.mergeAll(
    Layer.succeed(OrchestrationEngineService, system.engine),
    Layer.succeed(PeerGrantRepository, repositories.grants),
    Layer.succeed(PeerChildRepository, repositories.children),
    Layer.succeed(PeerChildStarterService, starter),
    Layer.succeed(RemoteBackendIdentityService, {
      authority: {
        authorityId: WORKER_AUTHORITY,
        keyEpoch: 1,
        keyFingerprint: `sha256:${"d".repeat(64)}`,
      },
      installationFingerprint: `sha256:${"e".repeat(64)}`,
      publicKey,
      signChallenge: () => {
        throw new Error("Peer routes must not sign.");
      },
    }),
  );
  const app = HttpRouter.toWebHandler(
    remotePeerRoutesLayer.pipe(HttpRouter.provideRequest(services)),
    { disableLogger: true },
  );
  const issue = (n: number, overrides: Partial<PeerGrant> = {}) =>
    system.run(
      repositories.grants.issue({
        grant: peerGrantFixture(n, {
          ceiling: {
            runtimeMode: "approval-required",
            providers: ["codex"],
            workspaceRoots: [WORKSPACE],
          },
          ...overrides,
        }),
        localCeiling: LOCAL_CEILING,
      }),
    );
  const post = makePoster(app);
  return {
    system,
    repositories,
    issue,
    post,
    coordinator: COORDINATOR_AUTHORITY,
    services,
    starter,
    dispose: async () => {
      await app.dispose();
      await system.run(Scope.close(starterScope, Exit.void));
      await system.dispose();
    },
  };
}
