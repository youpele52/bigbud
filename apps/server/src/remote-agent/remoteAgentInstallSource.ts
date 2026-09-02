import { readFile, stat } from "node:fs/promises";

import { version as serverVersion } from "../../package.json" with { type: "json" };
import { parseRemoteAgentArtifactManifest } from "./remoteAgentArtifact.ts";
import {
  parseRemoteAgentInstallSource,
  RemoteAgentInstallManagerError,
  type RemoteAgentInstallSource,
} from "./remoteAgentInstallManager.ts";
import {
  downloadRemoteAgentHttp,
  RemoteAgentDownloadError,
  type RemoteAgentFetch,
} from "./remoteAgentHttpDownload.ts";
import { REMOTE_AGENT_METADATA_DOWNLOAD_POLICY } from "./remoteAgentHttpDownload.policy.ts";
import type { RemoteAgentDownloadLogger } from "./remoteAgentHttpDownload.diagnostics.ts";

const DEFAULT_RELEASE_REPOSITORY = "youpele52/bigbud";
const MAX_INSTALL_SOURCE_BYTES = REMOTE_AGENT_METADATA_DOWNLOAD_POLICY.maxBytes;

interface InstallSourceLoadOptions {
  readonly signal?: AbortSignal;
  readonly allowLoopbackHttp?: boolean;
  readonly fetch?: RemoteAgentFetch;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly random?: () => number;
  readonly logger?: RemoteAgentDownloadLogger;
}

function resolveInstallSourceUrl(environment: NodeJS.ProcessEnv): string {
  const configured = environment.BIGBUD_REMOTE_AGENT_INSTALL_SOURCE_URL?.trim();
  if (configured) return configured;
  const repository =
    environment.BIGBUD_REMOTE_AGENT_RELEASE_REPOSITORY?.trim() || DEFAULT_RELEASE_REPOSITORY;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new RemoteAgentInstallManagerError(
      "BIGBUD_REMOTE_AGENT_RELEASE_REPOSITORY must use the owner/repository format.",
    );
  }
  const version = environment.BIGBUD_REMOTE_AGENT_RELEASE_VERSION?.trim() || serverVersion;
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(version)) {
    throw new RemoteAgentInstallManagerError("The remote agent release version is invalid.");
  }
  return `https://github.com/${repository}/releases/download/v${version}/remote-agent-install-source.json`;
}

function parseInstallSourceJson(bytes: Uint8Array, label: string): RemoteAgentInstallSource {
  try {
    return parseRemoteAgentInstallSource(JSON.parse(new TextDecoder().decode(bytes)));
  } catch (error) {
    throw new RemoteAgentInstallManagerError(
      `Remote agent install source from ${label} is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function readInstallSourceFile(
  path: string,
  signal?: AbortSignal,
): Promise<RemoteAgentInstallSource> {
  if (signal?.aborted) throw signal.reason ?? new DOMException("caller", "AbortError");
  try {
    const metadata = await stat(path);
    if (metadata.size <= 0 || metadata.size > MAX_INSTALL_SOURCE_BYTES) {
      throw new RemoteAgentInstallManagerError(
        `Remote agent install source file must be between 1 and ${MAX_INSTALL_SOURCE_BYTES} bytes.`,
      );
    }
    const bytes = await readFile(path, signal ? { signal } : undefined);
    return parseInstallSourceJson(bytes, "the configured local file");
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? new DOMException("caller", "AbortError");
    if (error instanceof RemoteAgentInstallManagerError) throw error;
    throw new RemoteAgentInstallManagerError(
      "Could not read the remote agent install source file.",
    );
  }
}

function urlPolicy(url: string, explicit: boolean, allowLoopbackHttp?: boolean) {
  let origin: string | undefined;
  try {
    origin = new URL(url).origin;
  } catch {
    // The downloader returns a privacy-safe invalid URL error.
  }
  return {
    ...(explicit && origin ? { allowedOrigins: new Set([origin]) } : {}),
    ...(allowLoopbackHttp ? { allowLoopbackHttp: true } : {}),
  };
}

async function downloadMetadata(
  url: string,
  explicit: boolean,
  options: InstallSourceLoadOptions,
): Promise<Uint8Array> {
  return downloadRemoteAgentHttp(
    {
      url,
      policy: REMOTE_AGENT_METADATA_DOWNLOAD_POLICY,
      ...(options.signal ? { signal: options.signal } : {}),
      urlPolicy: urlPolicy(url, explicit, options.allowLoopbackHttp),
    },
    options,
  );
}

async function loadDevelopmentReleaseManifest(
  url: string,
  options: InstallSourceLoadOptions,
): Promise<RemoteAgentInstallSource> {
  const manifestUrl = url.replace(
    /remote-agent-install-source\.json$/,
    "remote-agent-manifest.json",
  );
  try {
    const bytes = await downloadMetadata(manifestUrl, false, options);
    return {
      manifest: parseRemoteAgentArtifactManifest(JSON.parse(new TextDecoder().decode(bytes))),
      trustStore: {},
      allowUntrustedDevelopmentArtifact: true,
    };
  } catch (error) {
    if (
      error instanceof RemoteAgentDownloadError &&
      (error.details.abortOwner === "caller" || error.details.abortOwner === "shutdown")
    ) {
      throw error;
    }
    throw new RemoteAgentInstallManagerError(
      `No valid development remote-agent release is published (${error instanceof Error ? error.message : String(error)}). Publish the matching release, set BIGBUD_REMOTE_AGENT_INSTALL_SOURCE_PATH to a local install source, or use BIGBUD_REMOTE_AGENT_TRANSPORT=direct-ssh for local recovery.`,
    );
  }
}

export async function loadRemoteAgentInstallSource(
  environment: NodeJS.ProcessEnv = process.env,
  options: InstallSourceLoadOptions = {},
): Promise<RemoteAgentInstallSource> {
  const path = environment.BIGBUD_REMOTE_AGENT_INSTALL_SOURCE_PATH?.trim();
  if (path) return readInstallSourceFile(path, options.signal);

  const url = resolveInstallSourceUrl(environment);
  const explicitUrl = Boolean(environment.BIGBUD_REMOTE_AGENT_INSTALL_SOURCE_URL?.trim());
  try {
    const bytes = await downloadMetadata(url, explicitUrl, options);
    return parseInstallSourceJson(bytes, "the configured release host");
  } catch (error) {
    if (
      error instanceof RemoteAgentDownloadError &&
      error.details.status === 404 &&
      environment.BIGBUD_DESKTOP_PACKAGED === "0" &&
      !explicitUrl
    ) {
      return loadDevelopmentReleaseManifest(url, options);
    }
    if (error instanceof RemoteAgentInstallManagerError) throw error;
    throw new RemoteAgentInstallManagerError(
      error instanceof Error ? error.message : "Remote agent metadata download failed.",
    );
  }
}

function waitForSharedLoad(
  pending: Promise<RemoteAgentInstallSource>,
  signal: AbortSignal | undefined,
  onSettled: () => void,
): Promise<RemoteAgentInstallSource> {
  if (!signal) return pending.finally(onSettled);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = () => {
      if (settled) return false;
      settled = true;
      signal.removeEventListener("abort", abort);
      onSettled();
      return true;
    };
    const abort = () => {
      if (finish()) reject(signal.reason ?? new DOMException("caller", "AbortError"));
    };
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    pending.then(
      (source) => {
        if (finish()) resolve(source);
      },
      (error: unknown) => {
        if (finish()) reject(error);
      },
    );
  });
}

export function makeRemoteAgentInstallSourceLoader(
  environment: NodeJS.ProcessEnv = process.env,
  options: Omit<InstallSourceLoadOptions, "signal"> = {},
) {
  let cached: RemoteAgentInstallSource | undefined;
  let inFlight:
    | { promise: Promise<RemoteAgentInstallSource>; controller: AbortController; waiters: number }
    | undefined;
  return (signal?: AbortSignal): Promise<RemoteAgentInstallSource> => {
    if (signal?.aborted) {
      return Promise.reject(signal.reason ?? new DOMException("caller", "AbortError"));
    }
    if (cached) return Promise.resolve(cached);
    if (!inFlight) {
      const controller = new AbortController();
      const record = {
        controller,
        waiters: 0,
        promise: loadRemoteAgentInstallSource(environment, {
          ...options,
          signal: controller.signal,
        }),
      };
      record.promise = record.promise.then((source) => {
        if (inFlight === record) cached = source;
        return source;
      });
      record.promise
        .catch(() => undefined)
        .finally(() => {
          if (inFlight === record) inFlight = undefined;
        });
      inFlight = record;
    }
    const record = inFlight;
    record.waiters += 1;
    return waitForSharedLoad(record.promise, signal, () => {
      record.waiters -= 1;
      if (record.waiters === 0 && inFlight === record && !cached) {
        inFlight = undefined;
        record.controller.abort(new DOMException("caller", "AbortError"));
      }
    });
  };
}

export const loadProcessScopedRemoteAgentInstallSource = makeRemoteAgentInstallSourceLoader();
