import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

import { version as serverVersion } from "../../package.json" with { type: "json" };
import { loadRemoteAgentInstallSource } from "./remoteAgentInstallSource.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

function installSource() {
  return {
    manifest: {
      schemaVersion: 1,
      artifacts: [
        {
          version: "1.2.3",
          buildDigest: "build-1.2.3",
          protocolMajor: 1,
          protocolMinor: 0,
          targetTriple: "x86_64-unknown-linux-gnu",
          sizeBytes: 5,
          sha256: "a".repeat(64),
          signature: { algorithm: "ed25519", keyId: "release-2026", value: "signature" },
          url: "https://example.com/agent",
        },
      ],
    },
    trustStore: { "release-2026": "public-key" },
  };
}

describe("remote agent install source", () => {
  it("loads an explicit development or packaged source file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bigbud-agent-source-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "remote-agent-install-source.json");
    await writeFile(path, JSON.stringify(installSource()));

    const source = await loadRemoteAgentInstallSource({
      BIGBUD_REMOTE_AGENT_INSTALL_SOURCE_PATH: path,
    });

    expect(source.manifest.artifacts[0]?.version).toBe("1.2.3");
    expect(source.trustStore["release-2026"]).toBe("public-key");
  });

  it("rejects an invalid release repository before making a request", async () => {
    await expect(
      loadRemoteAgentInstallSource({ BIGBUD_REMOTE_AGENT_RELEASE_REPOSITORY: "invalid" }),
    ).rejects.toThrow("owner/repository");
  });

  it("preserves repository and version overrides", async () => {
    const request = vi.fn((_input: string | URL | Request, _init?: RequestInit) =>
      Promise.resolve(new Response(JSON.stringify(installSource()))),
    );

    await loadRemoteAgentInstallSource(
      {
        BIGBUD_REMOTE_AGENT_RELEASE_REPOSITORY: "owner/repository",
        BIGBUD_REMOTE_AGENT_RELEASE_VERSION: "2.3.4-rc.1",
      },
      { fetch: request, logger: () => undefined },
    );

    expect(String(request.mock.calls[0]?.[0])).toBe(
      "https://github.com/owner/repository/releases/download/v2.3.4-rc.1/remote-agent-install-source.json",
    );
  });

  it("resolves an unpinned local development build from the latest stable release", async () => {
    const request = vi.fn((_input: string | URL | Request, _init?: RequestInit) =>
      Promise.resolve(new Response(JSON.stringify(installSource()))),
    );

    await loadRemoteAgentInstallSource(
      { BIGBUD_DESKTOP_PACKAGED: "0" },
      { fetch: request, logger: () => undefined },
    );

    expect(String(request.mock.calls[0]?.[0])).toBe(
      "https://github.com/youpele52/bigbud/releases/latest/download/remote-agent-install-source.json",
    );
  });

  it("keeps packaged builds pinned to their release version", async () => {
    const request = vi.fn((_input: string | URL | Request, _init?: RequestInit) =>
      Promise.resolve(new Response(JSON.stringify(installSource()))),
    );

    await loadRemoteAgentInstallSource(
      { BIGBUD_DESKTOP_PACKAGED: "1" },
      { fetch: request, logger: () => undefined },
    );

    expect(String(request.mock.calls[0]?.[0])).toBe(
      `https://github.com/youpele52/bigbud/releases/download/v${serverVersion}/remote-agent-install-source.json`,
    );
  });

  it("allows an explicit source override and only follows same-origin redirects", async () => {
    const responses = [
      new Response(null, {
        status: 302,
        headers: { location: "https://fixtures.example/releases/install-source.json" },
      }),
      new Response(JSON.stringify(installSource())),
    ];
    const request = vi.fn((_input: string | URL | Request, _init?: RequestInit) => {
      return Promise.resolve(
        responses.shift() ??
          new Response(null, {
            status: 500,
          }),
      );
    });

    await loadRemoteAgentInstallSource(
      { BIGBUD_REMOTE_AGENT_INSTALL_SOURCE_URL: "https://fixtures.example/latest.json" },
      { fetch: request, logger: () => undefined },
    );

    expect(request.mock.calls.map(([url]) => String(url))).toEqual([
      "https://fixtures.example/latest.json",
      "https://fixtures.example/releases/install-source.json",
    ]);
  });

  it("fails closed when the latest development release has no install source", async () => {
    const request = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));

    await expect(
      loadRemoteAgentInstallSource(
        { BIGBUD_DESKTOP_PACKAGED: "0" },
        { fetch: request, logger: () => undefined },
      ),
    ).rejects.toThrow(
      "Remote agent install source is unavailable (HTTP 404). Publish the matching release, configure BIGBUD_REMOTE_AGENT_INSTALL_SOURCE_PATH or BIGBUD_REMOTE_AGENT_INSTALL_SOURCE_URL with a signed install source, or choose Direct SSH in the project's connection settings.",
    );
    expect(request).toHaveBeenCalledOnce();
    expect(String(request.mock.calls[0]?.[0])).toBe(
      "https://github.com/youpele52/bigbud/releases/latest/download/remote-agent-install-source.json",
    );
  });

  it("fails closed when the packaged release has no install source", async () => {
    const request = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));

    await expect(
      loadRemoteAgentInstallSource(
        { BIGBUD_DESKTOP_PACKAGED: "1" },
        { fetch: request, logger: () => undefined },
      ),
    ).rejects.toThrow("Remote agent install source is unavailable (HTTP 404)");
    expect(request).toHaveBeenCalledOnce();
    expect(String(request.mock.calls[0]?.[0])).toBe(
      `https://github.com/youpele52/bigbud/releases/download/v${serverVersion}/remote-agent-install-source.json`,
    );
  });

  it("rejects malformed metadata without retrying", async () => {
    const request = vi.fn().mockResolvedValue(new Response("{not-json"));
    vi.stubGlobal("fetch", request);

    await expect(loadRemoteAgentInstallSource()).rejects.toThrow("install source");
    expect(request).toHaveBeenCalledOnce();
  });

  it("rejects an unsupported metadata schema without retrying", async () => {
    const request = vi
      .fn()
      .mockResolvedValue(new Response('{"manifest":{"schemaVersion":2},"trustStore":{}}'));

    await expect(
      loadRemoteAgentInstallSource(undefined, {
        fetch: request,
        logger: () => undefined,
      }),
    ).rejects.toThrow("manifest schema");
    expect(request).toHaveBeenCalledOnce();
  });
});
