import * as Net from "node:net";

import type { DesktopBackendStartupState } from "@bigbud/contracts/server/ipc.desktop.ts";

export const BACKEND_RESUME_PROBE_TIMEOUT_MS = 3_000;

export type BackendPortProbeResult = "listening" | "refused" | "inconclusive";

/** One TCP connect to the renderer's own target; only a refusal is a definite failure. */
export function probeBackendPort(
  host: string,
  port: number,
  timeoutMs = BACKEND_RESUME_PROBE_TIMEOUT_MS,
): Promise<BackendPortProbeResult> {
  return new Promise((resolve) => {
    const socket = Net.createConnection({ host, port });
    let settled = false;
    const finish = (result: BackendPortProbeResult) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs, () => finish("inconclusive"));
    socket.once("connect", () => finish("listening"));
    socket.once("error", (error: NodeJS.ErrnoException) =>
      finish(error.code === "ECONNREFUSED" ? "refused" : "inconclusive"),
    );
  });
}

/** Resolves the host the renderer dials from the published WebSocket URL. */
export function resolveBackendProbeTarget(
  wsUrl: string,
): { readonly host: string; readonly port: number } | null {
  try {
    const url = new URL(wsUrl);
    const port = Number(url.port);
    if (!Number.isInteger(port) || port <= 0) return null;
    const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
    return { host, port };
  } catch {
    return null;
  }
}

export interface BackendResumeProbeDeps {
  readonly getWsUrl: () => string;
  readonly getStartupState: () => DesktopBackendStartupState;
  readonly getIsQuitting: () => boolean;
  readonly probe?: typeof probeBackendPort;
  /** Re-emits the current startup state so renderers get a definite `ready` after wake. */
  readonly republish: () => void;
  readonly restart: (reason: string) => void;
  readonly log: (event: string, details: string) => void;
}

/**
 * After a wake, checks the backend once. A listening port republishes `ready`; a refused
 * port restarts the backend. Startup states and inconclusive probes are left alone.
 */
export async function probeBackendAfterResume(deps: BackendResumeProbeDeps): Promise<void> {
  const state = deps.getStartupState();
  if (deps.getIsQuitting() || state.status !== "ready") {
    deps.log("resume_probe_skipped", `status=${state.status} generation=${state.generation}`);
    return;
  }
  const target = resolveBackendProbeTarget(deps.getWsUrl());
  if (!target) {
    deps.log("resume_probe_skipped", "reason=no_backend_target");
    return;
  }
  const result = await (deps.probe ?? probeBackendPort)(target.host, target.port);
  deps.log("resume_probe", `result=${result} generation=${state.generation}`);
  const current = deps.getStartupState();
  if (deps.getIsQuitting() || current.generation !== state.generation) return;
  if (result === "listening") deps.republish();
  else if (result === "refused") deps.restart("backend port refused connections after resume");
}
