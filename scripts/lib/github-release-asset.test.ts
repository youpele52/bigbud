import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { downloadGitHubReleaseAsset, gitHubReleaseAssetUrl } from "./github-release-asset";

const ref = { repository: "owner/repo", tag: "v1.2.3", assetName: "tool.tar.gz" };
const publicUrl = "https://github.com/owner/repo/releases/download/v1.2.3/tool.tar.gz";
const releaseUrl = "https://api.github.com/repos/owner/repo/releases/tags/v1.2.3";
const assetApiUrl = "https://api.github.com/repos/owner/repo/releases/assets/42";

const roots: Array<string> = [];
const destination = () => {
  const root = mkdtempSync(join(tmpdir(), "bigbud-release-asset-"));
  roots.push(root);
  return join(root, ref.assetName);
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type Route = (headers: Record<string, string>) => Response;

function fakeFetch(routes: Record<string, Array<Route>>) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, headers });
    const route = routes[url]?.shift();
    if (!route) throw new Error(`unexpected request ${url}`);
    return route(headers);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const bytes = (body: string) => () => new Response(body, { status: 200 });
const status = (code: number) => () => new Response("gateway", { status: code });

describe("GitHub release asset download", () => {
  it("builds the public download URL", () => {
    expect(gitHubReleaseAssetUrl(ref)).toBe(publicUrl);
  });

  it("retries the public URL before succeeding", async () => {
    const target = destination();
    const { fetch, calls } = fakeFetch({ [publicUrl]: [status(504), bytes("archive")] });
    await downloadGitHubReleaseAsset(ref, target, { fetch, retryDelayMs: 0, token: "" });
    expect(readFileSync(target, "utf8")).toBe("archive");
    expect(calls.map((call) => call.url)).toEqual([publicUrl, publicUrl]);
  });

  it("falls back to the API asset endpoint and sends the token only there", async () => {
    const target = destination();
    const { fetch, calls } = fakeFetch({
      [publicUrl]: [status(504), status(504)],
      [releaseUrl]: [
        () =>
          Response.json({
            assets: [
              { name: "other", url: "x" },
              { name: ref.assetName, url: assetApiUrl },
            ],
          }),
      ],
      [assetApiUrl]: [bytes("from-api")],
    });
    await downloadGitHubReleaseAsset(ref, target, {
      fetch,
      attempts: 2,
      retryDelayMs: 0,
      token: "secret",
    });
    expect(readFileSync(target, "utf8")).toBe("from-api");
    expect(calls.filter((call) => call.url === publicUrl).map((call) => call.headers)).toEqual([
      {},
      {},
    ]);
    expect(calls.at(-1)?.headers).toEqual({
      Accept: "application/octet-stream",
      Authorization: "Bearer secret",
    });
  });

  it("reports every failure when the asset cannot be found", async () => {
    const { fetch } = fakeFetch({
      [publicUrl]: [status(504)],
      [releaseUrl]: [() => Response.json({ assets: [] })],
    });
    await expect(
      downloadGitHubReleaseAsset(ref, destination(), { fetch, attempts: 1, token: "" }),
    ).rejects.toThrow(/attempt 1: .*HTTP 504; api: .*has no asset 'tool.tar.gz'/);
  });
});
