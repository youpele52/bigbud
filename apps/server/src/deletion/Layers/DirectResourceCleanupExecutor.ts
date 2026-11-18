import { randomUUID } from "node:crypto";

import { Effect, Layer, Option } from "effect";

import {
  DirectResourceCleanupExecutor,
  DirectResourceCleanupExecutorError,
  type DirectResourceCleanupExecutorShape,
} from "../Services/DirectResourceCleanupExecutor.ts";
import { RemoteAgentConnection } from "../../remote-agent/remoteAgentConnection.ts";
import { resolveLocalWorkspaceWatchAgentBinary } from "../../remote-agent/localWorkspaceWatchAgent.binary.ts";
import { REMOTE_AGENT_PROTOCOL_MINOR } from "../../remote-agent/remoteAgentProtocol.ts";
import { assertAllowedDirectCleanupRoot } from "./DirectResourceCleanup.roots.ts";
import { ServerConfig } from "../../startup/config.ts";

/** Hosts whose `bigbud-remote-agent` build is qualified for `--resource-cleanup`. */
const SUPPORTED = new Set(["darwin/arm64", "darwin/x64", "linux/arm64", "linux/x64", "win32/x64"]);

export interface DirectResourceCleanupHost {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
}

const PROCESS_HOST: DirectResourceCleanupHost = { platform: process.platform, arch: process.arch };

function rustPlatform(platform: NodeJS.Platform): string {
  return platform === "darwin" ? "macos" : platform === "win32" ? "windows" : platform;
}

function rustArchitecture(architecture: string): string {
  return architecture === "x64" ? "x86_64" : architecture === "arm64" ? "aarch64" : architecture;
}

async function withTimeout<A>(promise: Promise<A>, timeoutMs: number): Promise<A> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Resource cleanup executor timed out.")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/**
 * `pinnedBinaryPath` is an agent the host already verified, such as the remote account service's
 * pinned Rust agent; the resolver still checks its identity and protocol before use.
 */
function resolveCleanupBinary(pinnedBinaryPath?: string): string {
  return resolveLocalWorkspaceWatchAgentBinary({
    ...(process.env.VITEST ? { environment: {} } : {}),
    ...(pinnedBinaryPath ? { packagedBinaryPath: pinnedBinaryPath } : {}),
  });
}

export function makeDirectResourceCleanupExecutor(
  resolveBinary: () => string = resolveCleanupBinary,
  host: DirectResourceCleanupHost = PROCESS_HOST,
): DirectResourceCleanupExecutorShape {
  return {
    prepare: () =>
      Effect.tryPromise({
        try: async () => {
          if (!SUPPORTED.has(`${host.platform}/${host.arch}`)) {
            throw new Error(`Resource cleanup is unsupported on ${host.platform}/${host.arch}.`);
          }
          const connection = RemoteAgentConnection.local({
            binaryPath: resolveBinary(),
            args: ["--resource-cleanup"],
          });
          try {
            const hello = await withTimeout(connection.handshake(), 5_000);
            if (
              hello.os !== rustPlatform(host.platform) ||
              hello.architecture !== rustArchitecture(host.arch) ||
              hello.protocolMinor < REMOTE_AGENT_PROTOCOL_MINOR ||
              !hello.capabilities.some(
                (capability) => capability.name === "resource.cleanup" && capability.major === 1,
              )
            ) {
              throw new Error("The local resource cleanup executor is incompatible.");
            }
            let keepAliveFailure: unknown;
            let keepAliveInFlight = false;
            let executing = false;
            const keepAlive = async () => {
              if (keepAliveFailure) throw keepAliveFailure;
              const requestId = randomUUID();
              await withTimeout(
                connection.request(
                  { type: "resourceCleanupKeepAliveRequest", value: { requestId } },
                  (frame) =>
                    frame.type === "resourceCleanupKeepAliveResponse" &&
                    frame.value.requestId === requestId,
                ),
                5_000,
              );
            };
            const keepAliveTimer = setInterval(() => {
              if (executing || keepAliveInFlight || keepAliveFailure) return;
              keepAliveInFlight = true;
              void keepAlive()
                .catch((error: unknown) => {
                  keepAliveFailure = error;
                })
                .finally(() => {
                  keepAliveInFlight = false;
                });
            }, 10_000);
            return {
              identity: {
                buildVersion: hello.agentVersion,
                buildDigest: hello.buildDigest,
                protocolMajor: hello.protocolMajor,
                protocolMinor: hello.protocolMinor,
              },
              assertAlive: keepAlive,
              execute: async (input) => {
                if (keepAliveFailure) throw keepAliveFailure;
                executing = true;
                try {
                  const roots = [
                    ...new Map(
                      input.resources.map((resource) => [resource.root, resource]),
                    ).values(),
                  ];
                  roots.forEach((resource) => assertAllowedDirectCleanupRoot(resource.root));
                  const rootRequestId = randomUUID();
                  const bootstrap = await withTimeout(
                    connection.request(
                      {
                        type: "resourceCleanupRootBootstrapRequest",
                        value: {
                          requestId: rootRequestId,
                          platform: hello.os,
                          roots: roots.map((resource, index) => ({
                            rootId: String(index),
                            path: resource.root,
                            identity: resource.rootIdentity,
                          })),
                        },
                      },
                      (frame) =>
                        frame.type === "resourceCleanupRootBootstrapResponse" &&
                        frame.value.requestId === rootRequestId,
                    ),
                    5_000,
                  );
                  if (
                    bootstrap.type !== "resourceCleanupRootBootstrapResponse" ||
                    !bootstrap.value.accepted
                  ) {
                    throw new Error(
                      `Resource cleanup root bootstrap failed: ${bootstrap.type === "resourceCleanupRootBootstrapResponse" ? bootstrap.value.errorCode : "PROTOCOL_FAILURE"}`,
                    );
                  }
                  if (
                    bootstrap.value.roots.length !== roots.length ||
                    new Set(bootstrap.value.roots.map((root) => root.rootId)).size !==
                      roots.length ||
                    bootstrap.value.roots.some(
                      (root) =>
                        root.rootHandle.length === 0 ||
                        !/^(?:0|[1-9]\d*)$/.test(root.rootId) ||
                        !Number.isSafeInteger(Number(root.rootId)) ||
                        roots[Number(root.rootId)] === undefined,
                    )
                  ) {
                    throw new Error("Resource cleanup returned invalid root handles.");
                  }
                  const handles = new Map(
                    bootstrap.value.roots.map((root) => [
                      roots[Number(root.rootId)]?.root,
                      root.rootHandle,
                    ]),
                  );
                  const requestId = input.request.requestId;
                  const expectedHandles = input.resources.map(
                    (resource) => handles.get(resource.root) ?? "",
                  );
                  if (
                    input.request.resources.length !== input.resources.length ||
                    input.request.resources.some(
                      (resource, index) => resource.rootHandle !== expectedHandles[index],
                    )
                  ) {
                    throw new Error("Stored cleanup request root handles do not match bootstrap.");
                  }
                  const cancelRequestId = randomUUID();
                  const requestPromise = withTimeout(
                    connection.requestEncoded(
                      input.encodedRequest,
                      (frame) =>
                        frame.type === "resourceCleanupResponse" &&
                        frame.value.requestId === requestId,
                    ),
                    35_000,
                  );
                  const cancel = () => {
                    void connection
                      .send({
                        type: "resourceCleanupCancelRequest",
                        value: {
                          requestId: cancelRequestId,
                          operationId: input.request.operationId,
                        },
                      })
                      .catch(() => undefined);
                  };
                  input.signal?.addEventListener("abort", cancel, { once: true });
                  if (input.signal?.aborted) cancel();
                  const response = await requestPromise.finally(() =>
                    input.signal?.removeEventListener("abort", cancel),
                  );
                  if (response.type !== "resourceCleanupResponse") {
                    throw new Error("Resource cleanup returned an unexpected frame.");
                  }
                  const expectedIds = new Set(
                    input.resources.map((resource) => resource.resourceId),
                  );
                  const resultIds = new Set(
                    response.value.results.map((result) => result.resourceId),
                  );
                  if (
                    response.value.operationId !== input.request.operationId ||
                    response.value.results.length !== expectedIds.size ||
                    resultIds.size !== expectedIds.size ||
                    [...resultIds].some((resourceId) => !expectedIds.has(resourceId))
                  ) {
                    throw new Error("Resource cleanup returned an invalid result set.");
                  }
                  return response.value.results;
                } finally {
                  executing = false;
                }
              },
              close: () => {
                clearInterval(keepAliveTimer);
                connection.close();
              },
              shutdown: async () => {
                clearInterval(keepAliveTimer);
                await connection.gracefulClose(2_000);
              },
            };
          } catch (error) {
            connection.close();
            throw error;
          }
        },
        catch: (error) =>
          new DirectResourceCleanupExecutorError({ detail: String(error), cause: error }),
      }),
  };
}

export const DirectResourceCleanupExecutorLive = Layer.effect(
  DirectResourceCleanupExecutor,
  Effect.gen(function* () {
    const config = yield* Effect.serviceOption(ServerConfig);
    const pinned = Option.isSome(config) ? config.value.workspaceAgentBinaryPath : undefined;
    return makeDirectResourceCleanupExecutor(() => resolveCleanupBinary(pinned));
  }),
);
