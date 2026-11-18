import { describe, expect, it } from "vitest";

import {
  exitCodeFor,
  formatReports,
  parseArgs,
  PUBLISHED_SCRIPT_URL,
  releaseScriptUrl,
  verifyPublishedRemoteAgentScript,
} from "./verify-published-remote-agent-script.ts";

const SCRIPT = Buffer.from("#!/bin/sh\necho staged\n");
const RELEASE_URL = "https://github.com/youpele52/bigbud/releases/download/v1.2.3/remote-agent.sh";

type Route = (init: RequestInit | undefined) => Response | Promise<Response>;

function stubFetch(routes: Record<string, Route>) {
  const seen: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    seen.push({ url, init });
    const route = routes[url];
    if (!route) throw new TypeError(`fetch failed: no route for ${url}`);
    return route(init);
  }) as typeof globalThis.fetch;
  return { fetch, seen };
}

const body = (bytes: Buffer | string) => () =>
  new Response(typeof bytes === "string" ? bytes : new Uint8Array(bytes));
const redirect = (location: string) => () =>
  new Response(null, { status: 302, headers: { location } });

async function verify(routes: Record<string, Route>, extra: { release?: string } = {}) {
  const stub = stubFetch(routes);
  const reports = await verifyPublishedRemoteAgentScript({
    fetch: stub.fetch,
    expected: SCRIPT,
    timeoutMs: 200,
    ...extra,
  });
  return { reports, seen: stub.seen, code: exitCodeFor(reports) };
}

describe("verifyPublishedRemoteAgentScript", () => {
  it("reports a match and sends no identifying request data", async () => {
    const { reports, seen, code } = await verify({ [PUBLISHED_SCRIPT_URL]: body(SCRIPT) });
    expect(code).toBe(0);
    expect(reports.map((report) => report.status)).toEqual(["match"]);
    const init = seen[0]!.init!;
    expect(init.redirect).toBe("manual");
    expect(init.credentials).toBe("omit");
    expect(Object.keys(init.headers as Record<string, string>).toSorted()).toEqual([
      "accept",
      "user-agent",
    ]);
  });

  it("reports a mismatch with both hashes", async () => {
    const { reports, code } = await verify({ [PUBLISHED_SCRIPT_URL]: body("#!/bin/sh\nold\n") });
    expect(code).toBe(1);
    expect(reports[0]!.status).toBe("mismatch");
    expect(formatReports(SCRIPT, reports)).toMatch(/site: MISMATCH[\s\S]*expected: [0-9a-f]{64}/);
  });

  it("explains an HTML fallback page served in place of the script", async () => {
    const { reports, code } = await verify({
      [PUBLISHED_SCRIPT_URL]: () =>
        new Response("<!DOCTYPE html><html></html>", {
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    });
    expect(code).toBe(1);
    expect(reports[0]!.lines.join("\n")).toContain("not deployed at this URL");
  });

  it("follows an allowed redirect and records the hops", async () => {
    const www = "https://www.bigbud.app/remote-agent.sh";
    const { reports, code } = await verify({
      [PUBLISHED_SCRIPT_URL]: redirect(www),
      [www]: body(SCRIPT),
    });
    expect(code).toBe(0);
    expect(reports[0]!.lines.join("\n")).toContain(`via: ${PUBLISHED_SCRIPT_URL} -> ${www}`);
  });

  it("refuses a redirect to raw.githubusercontent.com and says why", async () => {
    const raw = "https://raw.githubusercontent.com/youpele52/bigbud/main/remote-agent.sh";
    const { reports, seen, code } = await verify({
      [PUBLISHED_SCRIPT_URL]: redirect(raw),
      [raw]: body(SCRIPT),
    });
    expect(code).toBe(1);
    expect(seen.map((entry) => entry.url)).toEqual([PUBLISHED_SCRIPT_URL]);
    expect(reports[0]!.lines.join("\n")).toMatch(/disallowed location[\s\S]*moving branch/);
  });

  it("refuses an https-to-http downgrade on an allowed host", async () => {
    const { code } = await verify({
      [PUBLISHED_SCRIPT_URL]: redirect("http://bigbud.app/remote-agent.sh"),
    });
    expect(code).toBe(1);
  });

  it("treats a redirect loop as unreachable", async () => {
    const { reports, code } = await verify({
      [PUBLISHED_SCRIPT_URL]: redirect(PUBLISHED_SCRIPT_URL),
    });
    expect(code).toBe(2);
    expect(reports[0]!.lines[0]).toContain("more than 5 redirects");
  });

  it("rejects oversize content by declared length and while streaming", async () => {
    const declared = await verify({
      [PUBLISHED_SCRIPT_URL]: () =>
        new Response("x", { headers: { "content-length": String(10 * 1024 * 1024) } }),
    });
    expect(declared.code).toBe(1);
    expect(declared.reports[0]!.lines[0]).toContain("exceeds");
    let pulls = 0;
    const streamed = await verify({
      [PUBLISHED_SCRIPT_URL]: () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              pulls += 1;
              controller.enqueue(new Uint8Array(64 * 1024));
            },
          }),
        ),
    });
    expect(streamed.code).toBe(1);
    expect(pulls).toBeLessThan(10);
  });

  it("reports a timeout as unreachable", async () => {
    const { reports, code } = await verify({
      [PUBLISHED_SCRIPT_URL]: (init) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    });
    expect(code).toBe(2);
    expect(reports[0]!.lines[0]).toContain("timed out after 200 ms");
  });

  it("reports network failures and HTTP errors as unreachable", async () => {
    expect((await verify({})).code).toBe(2);
    const missing = await verify({
      [PUBLISHED_SCRIPT_URL]: () => new Response("nope", { status: 404 }),
    });
    expect(missing.reports[0]!.lines[0]).toContain("HTTP 404");
  });

  it("checks the release asset through GitHub's download hosts", async () => {
    const asset = "https://release-assets.githubusercontent.com/github-production/abc";
    const { reports, code } = await verify(
      {
        [PUBLISHED_SCRIPT_URL]: body(SCRIPT),
        [RELEASE_URL]: redirect(asset),
        [asset]: body(SCRIPT),
      },
      { release: "1.2.3" },
    );
    expect(code).toBe(0);
    expect(reports.map((report) => report.label)).toEqual(["site", "release 1.2.3"]);
  });

  it("prefers mismatch over unreachable when sources disagree", async () => {
    const { code } = await verify(
      { [PUBLISHED_SCRIPT_URL]: body("different") },
      { release: "v1.2.3" },
    );
    expect(code).toBe(1);
  });
});

describe("argument parsing", () => {
  it("parses flags and validates values", () => {
    expect(parseArgs(["--release", "v1.2.3", "--timeout-ms=500"])).toEqual({
      help: false,
      release: "v1.2.3",
      timeoutMs: 500,
    });
    expect(() => parseArgs(["--timeout-ms", "0"])).toThrow(/between/);
    expect(() => parseArgs(["--bogus", "x"])).toThrow(/Unknown argument/);
    expect(() => parseArgs(["--release"])).toThrow(/requires a value/);
  });

  it("builds release URLs only from safe inputs", () => {
    expect(releaseScriptUrl("youpele52/bigbud", "1.2.3")).toBe(RELEASE_URL);
    expect(() => releaseScriptUrl("a/b/c", "1.2.3")).toThrow(/owner\/repository/);
    expect(() => releaseScriptUrl("a/b", "../x")).toThrow(/version tag/);
  });
});
