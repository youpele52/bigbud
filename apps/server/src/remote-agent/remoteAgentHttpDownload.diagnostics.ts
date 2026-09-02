import { randomUUID } from "node:crypto";

import { Effect } from "effect";

import type { RemoteAgentDownloadKind } from "./remoteAgentHttpDownload.policy.ts";

export type RemoteAgentDownloadDiagnostic = Readonly<Record<string, unknown>> & {
  readonly operationId: string;
  readonly correlationId: string;
  readonly kind: RemoteAgentDownloadKind;
};

export type RemoteAgentDownloadLogger = (
  message: string,
  details: RemoteAgentDownloadDiagnostic,
) => void;

let runtimeLogged = false;

export function defaultRemoteAgentDownloadLogger(
  message: string,
  details: RemoteAgentDownloadDiagnostic,
): void {
  Effect.runFork(Effect.logInfo(message, details));
}

export function makeDownloadOperationId(): string {
  return randomUUID();
}

export function logDownloadRuntimeOnce(
  logger: RemoteAgentDownloadLogger,
  operationId: string,
  kind: RemoteAgentDownloadKind,
): void {
  if (runtimeLogged) return;
  runtimeLogged = true;
  logger("remote agent download runtime", {
    operationId,
    correlationId: operationId,
    kind,
    nodeVersion: process.versions.node,
    electronVersion: process.versions.electron,
    undiciVersion: process.versions.undici,
  });
}
