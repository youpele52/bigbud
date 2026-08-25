import { readFile, stat } from "node:fs/promises";

import { version as serverVersion } from "../../package.json" with { type: "json" };
import { parseRemoteAgentArtifactManifest } from "./remoteAgentArtifact.ts";
import {
  parseRemoteAgentInstallSource,
  RemoteAgentInstallManagerError,
  type RemoteAgentInstallSource,
} from "./remoteAgentInstallManager.ts";

const DEFAULT_RELEASE_REPOSITORY = "youpele52/bigbud";
const MAX_INSTALL_SOURCE_BYTES = 1024 * 1024;

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

async function readInstallSourceFile(path: string): Promise<RemoteAgentInstallSource> {
  const metadata = await stat(path);
  if (metadata.size <= 0 || metadata.size > MAX_INSTALL_SOURCE_BYTES) {
    throw new RemoteAgentInstallManagerError(
      `Remote agent install source file must be between 1 and ${MAX_INSTALL_SOURCE_BYTES} bytes.`,
    );
  }
  return parseInstallSourceJson(await readFile(path), path);
}

async function readInstallSourceResponse(response: Response, url: string): Promise<Uint8Array> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_INSTALL_SOURCE_BYTES) {
    throw new RemoteAgentInstallManagerError("Remote agent install source response is too large.");
  }
  if (!response.body) {
    throw new RemoteAgentInstallManagerError("Remote agent install source response has no body.");
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.byteLength;
    if (total > MAX_INSTALL_SOURCE_BYTES) {
      throw new RemoteAgentInstallManagerError(
        "Remote agent install source response is too large.",
      );
    }
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (bytes.byteLength === 0) {
    throw new RemoteAgentInstallManagerError(`Remote agent install source from ${url} is empty.`);
  }
  return bytes;
}

async function loadDevelopmentReleaseManifest(url: string): Promise<RemoteAgentInstallSource> {
  const manifestUrl = url.replace(
    /remote-agent-install-source\.json$/,
    "remote-agent-manifest.json",
  );
  const response = await fetch(manifestUrl, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) {
    throw new RemoteAgentInstallManagerError(
      `No development remote-agent release is published at ${manifestUrl} (HTTP ${response.status}). Publish the matching release, set BIGBUD_REMOTE_AGENT_INSTALL_SOURCE_PATH to a local install source, or use BIGBUD_REMOTE_AGENT_TRANSPORT=direct-ssh for local recovery.`,
    );
  }
  try {
    const bytes = await readInstallSourceResponse(response, manifestUrl);
    return {
      manifest: parseRemoteAgentArtifactManifest(JSON.parse(new TextDecoder().decode(bytes))),
      trustStore: {},
      allowUntrustedDevelopmentArtifact: true,
    };
  } catch (error) {
    throw new RemoteAgentInstallManagerError(
      `Development remote agent manifest from ${manifestUrl} is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function loadRemoteAgentInstallSource(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<RemoteAgentInstallSource> {
  const path = environment.BIGBUD_REMOTE_AGENT_INSTALL_SOURCE_PATH?.trim();
  if (path) return readInstallSourceFile(path);

  const url = resolveInstallSourceUrl(environment);
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  } catch (error) {
    throw new RemoteAgentInstallManagerError(
      `Could not download the remote agent install source from ${url}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) {
    if (
      response.status === 404 &&
      environment.BIGBUD_DESKTOP_PACKAGED === "0" &&
      !environment.BIGBUD_REMOTE_AGENT_INSTALL_SOURCE_URL
    ) {
      return loadDevelopmentReleaseManifest(url);
    }
    throw new RemoteAgentInstallManagerError(
      `Remote agent install source download failed with HTTP ${response.status} from ${url}.`,
    );
  }
  return parseInstallSourceJson(await readInstallSourceResponse(response, url), url);
}
