import { afterEach, describe, expect, it, vi } from "vitest";

import { handleMarketingRequest, matchRemoteAgentRef } from "./marketingWorker";

const ASSET_BODY = "static asset";

function makeEnv() {
  return { ASSETS: { fetch: vi.fn(async (_request: Request) => new Response(ASSET_BODY)) } };
}

const context = { waitUntil: vi.fn() };

function request(path: string, method = "GET") {
  return new Request(`https://bigbud.app${path}`, { method });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("matchRemoteAgentRef", () => {
  it("returns the decoded ref for the remote agent path only", () => {
    expect(matchRemoteAgentRef("/download/beta/remote-agent")).toBe("beta");
    expect(matchRemoteAgentRef("/download/v0.4.0%2Dbeta.5/remote-agent")).toBe("v0.4.0-beta.5");
    expect(matchRemoteAgentRef("/download/%E0%A4%A/remote-agent")).toBeUndefined();
    expect(matchRemoteAgentRef("/download/")).toBeNull();
    expect(matchRemoteAgentRef("/download/beta/remote-agent/extra")).toBeNull();
    expect(matchRemoteAgentRef("/download/a/b/remote-agent")).toBeNull();
  });
});

describe("handleMarketingRequest", () => {
  it("passes every other request to the static assets", async () => {
    for (const path of ["/", "/nope", "/download/", "/remote-agent.sh", "/download/x/other"]) {
      const env = makeEnv();
      const response = await handleMarketingRequest(request(path), env, context);
      expect(await response.text()).toBe(ASSET_BODY);
      expect(env.ASSETS.fetch).toHaveBeenCalledOnce();
    }
  });

  it("leaves non-read methods on the remote agent path to the static assets", async () => {
    const env = makeEnv();
    await handleMarketingRequest(request("/download/beta/remote-agent", "POST"), env, context);
    expect(env.ASSETS.fetch).toHaveBeenCalledOnce();
  });

  it("redirects a pinned tag without touching the assets", async () => {
    vi.stubGlobal("caches", { default: { match: vi.fn(), put: vi.fn() } });
    const env = makeEnv();
    const response = await handleMarketingRequest(
      request("/download/0.4.0-beta.5/remote-agent"),
      env,
      context,
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(
      "https://github.com/youpele52/bigbud/releases/download/v0.4.0-beta.5/remote-agent.sh",
    );
    expect(env.ASSETS.fetch).not.toHaveBeenCalled();
  });

  it("answers HEAD with the same status and headers but no body", async () => {
    vi.stubGlobal("caches", { default: { match: vi.fn(), put: vi.fn() } });
    const response = await handleMarketingRequest(
      request("/download/bogus..x/remote-agent", "HEAD"),
      makeEnv(),
      context,
    );
    expect(response.status).toBe(404);
    expect(response.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(response.body).toBeNull();
  });
});
