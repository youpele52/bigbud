import http from "node:http";
import type { AddressInfo } from "node:net";
import { expect } from "vitest";

import type {
  ProofOpencodeServiceScope,
  ProofOpencodeState,
} from "../../../ssh/sshOwnerPickerProof.codec.opencode.ts";
import type { PickerProofProductionProxyClient } from "../../../ssh/sshOwnerPickerProof.client.productionProxy.ts";
import {
  makeV2SshOwner,
  type V2SshOwner,
  type V2SshOwnerClient,
} from "./ServerManager.sshOwner.ts";
import {
  SelectedV2OwnerError,
  type V2OwnerSessionSource,
} from "./ServerManager.ownerV2.selected.ts";
import { v2OfficialContract } from "./SharedService.official.fixture.ts";
import type { OwnedV2Process, V2IsolatedProcessConfig } from "./ServerManager.types.ts";

/** Shared fixtures for the selected OpenCode v2 owner composition tests. */
export const cleanups: Array<() => Promise<void>> = [];

export async function cleanupFixtures(): Promise<void> {
  for (const cleanup of cleanups.splice(0)) await cleanup();
}

export const binding = () => ({
  ownerEpoch: new Uint8Array(32).fill(1),
  targetGeneration: new Uint8Array(32).fill(2),
});

export const config = (targetId = "ssh:fixture"): V2IsolatedProcessConfig => ({
  runtimeTargetId: targetId,
  // Host-side setting; the composition must replace it with the owner binding.
  binaryPath: "/host/opencode",
  profileRoot: "/nonexistent/bigbud-v2-profile/not-a-directory",
  workspaceRoot: `/srv/${targetId.replaceAll(/[^a-z0-9]/gi, "_")}`,
});

/** Loopback v2 fixture: authenticated `/api/info` plus the consumed OpenAPI contract. */
export async function v2Server(password: string, requests: string[], version = "2.1.4") {
  const contract = v2OfficialContract();
  const server = http.createServer((request, response) => {
    requests.push(`${request.url} ${request.headers.authorization ?? ""}`);
    if (
      request.headers.authorization !==
      `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
    ) {
      response.writeHead(401);
      response.end();
      return;
    }
    if (request.url === "/api/info") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ version, pid: 4242, urls: [], paths: { tmp: "/tmp" } }));
      return;
    }
    if (request.url === "/openapi.json") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(contract));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return (server.address() as AddressInfo).port;
}

export function ownerClient(
  port: number,
  password: string,
  calls: string[],
  scopes: ProofOpencodeServiceScope[],
): V2SshOwnerClient {
  let lease: Uint8Array | undefined;
  const client: Pick<
    PickerProofProductionProxyClient,
    "openOpencodeV2" | "opencodeV2Status" | "closeOpencodeV2"
  > = {
    async openOpencodeV2(ticket, scope) {
      scopes.push(scope);
      calls.push(`open ${scope.transport} ${scope.threadId} ${scope.cwd}`);
      lease = Uint8Array.from(ticket);
      return { lease, phase: "ready", localPort: port, password };
    },
    async opencodeV2Status(ticket) {
      if (!lease || !Buffer.from(ticket).equals(Buffer.from(lease)))
        throw new Error("lease mismatch");
      return { lease, phase: "ready", localPort: port, password };
    },
    async closeOpencodeV2(ticket) {
      calls.push("close");
      const state: ProofOpencodeState = { lease: ticket, phase: "closed" };
      lease = undefined;
      return state;
    },
  };
  return client;
}

export interface TargetFixture {
  readonly remoteBinary: string;
  readonly port: number;
  readonly password: string;
  readonly calls: string[];
  readonly scopes: ProofOpencodeServiceScope[];
  readonly requests: string[];
}

export async function targetFixture(remoteBinary: string): Promise<TargetFixture> {
  const password = `pw-${remoteBinary.replaceAll(/[^a-z0-9]/gi, "")}-${Math.random()}`;
  const requests: string[] = [];
  const port = await v2Server(password, requests);
  return { remoteBinary, port, password, calls: [], scopes: [], requests };
}

export function sourceFor(
  targets: Readonly<Record<string, TargetFixture>>,
  serviceBinding: unknown,
): V2OwnerSessionSource {
  return {
    async target(targetId) {
      const fixture = targets[targetId];
      if (!fixture) return undefined;
      return {
        targetId,
        owner: makeV2SshOwner(
          ownerClient(fixture.port, fixture.password, fixture.calls, fixture.scopes),
          targetId,
          binding,
          fixture.remoteBinary,
        ),
        serviceBinding,
      };
    },
  };
}

export function track(process: OwnedV2Process) {
  cleanups.push(() => process.close().catch(() => undefined));
  return process;
}

export const refusal = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error("expected a typed refusal");
    },
    (error: unknown) => {
      expect(error).toBeInstanceOf(SelectedV2OwnerError);
      return (error as SelectedV2OwnerError).reason;
    },
  );

export const noTarget = async (): Promise<undefined> => undefined;

export const unusedOwner = {
  startProvider: () => {
    throw new Error("the refusal tests never start a provider");
  },
} as unknown as V2SshOwner;

export const targetWithBinding = (serviceBinding: unknown): V2OwnerSessionSource => ({
  target: async (targetId) => ({
    targetId,
    owner: unusedOwner,
    serviceBinding,
  }),
});
