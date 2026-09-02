import { open } from "node:fs/promises";

import type { RemoteAgentArtifact } from "./remoteAgentArtifact.ts";
import {
  downloadRemoteAgentHttp,
  type RemoteAgentHttpDownloadDependencies,
} from "./remoteAgentHttpDownload.ts";
import { REMOTE_AGENT_ARTIFACT_DOWNLOAD_POLICY } from "./remoteAgentHttpDownload.policy.ts";

export interface RemoteAgentArtifactDownloadOptions extends RemoteAgentHttpDownloadDependencies {
  readonly signal?: AbortSignal;
  readonly allowLoopbackHttp?: boolean;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("caller", "AbortError");
}

async function readBundledArtifact(
  path: string,
  sizeBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  throwIfAborted(signal);
  const file = await open(path, "r");
  try {
    const metadata = await file.stat();
    if (metadata.size !== sizeBytes) {
      throw new Error("Bundled remote agent length does not match its signed manifest.");
    }
    const bytes = new Uint8Array(sizeBytes);
    let offset = 0;
    while (offset < bytes.byteLength) {
      throwIfAborted(signal);
      const { bytesRead } = await file.read(bytes, offset, bytes.byteLength - offset, offset);
      if (bytesRead === 0) {
        throw new Error("Bundled remote agent is shorter than its signed manifest length.");
      }
      offset += bytesRead;
    }
    const trailing = new Uint8Array(1);
    if ((await file.read(trailing, 0, 1, offset)).bytesRead !== 0) {
      throw new Error("Bundled remote agent exceeds its signed manifest length.");
    }
    return bytes;
  } finally {
    await file.close();
  }
}

export async function downloadRemoteAgentArtifact(
  artifact: RemoteAgentArtifact,
  options: RemoteAgentArtifactDownloadOptions = {},
): Promise<Uint8Array> {
  if (artifact.sizeBytes > REMOTE_AGENT_ARTIFACT_DOWNLOAD_POLICY.maxBytes) {
    throw new Error(
      `Remote agent artifact exceeds the ${REMOTE_AGENT_ARTIFACT_DOWNLOAD_POLICY.maxBytes} byte limit.`,
    );
  }
  if (artifact.bundledPath) {
    return readBundledArtifact(artifact.bundledPath, artifact.sizeBytes, options.signal);
  }
  if (!artifact.url) {
    throw new Error("Remote agent artifact has no local or URL source.");
  }
  return downloadRemoteAgentHttp(
    {
      url: artifact.url,
      policy: REMOTE_AGENT_ARTIFACT_DOWNLOAD_POLICY,
      expectedBytes: artifact.sizeBytes,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.allowLoopbackHttp ? { urlPolicy: { allowLoopbackHttp: true } } : {}),
    },
    options,
  );
}
