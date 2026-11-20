import { describe, expect, it } from "vitest";

import {
  downloadUrl,
  exitCodeFor,
  formatReports,
  parseArgs,
  releaseScriptUrl,
  RETIRED_SCRIPT_URL,
  verifyPublishedRemoteAgentScript,
} from "./verify-published-remote-agent-script.ts";

const SCRIPT = Buffer.from('#!/bin/sh\nDEFAULT_VERSION="" # stamped by release.yml\necho staged\n');
const stamped = (version: string) =>
  SCRIPT.toString("utf8").replace('DEFAULT_VERSION=""', `DEFAULT_VERSION="${version}"`);
const RELEASE_URL = "https://github.com/youpele52/bigbud/releases/download/v1.2.3/remote-agent.sh";
const BETA_URL = "https://bigbud.app/download/beta/remote-agent";
const ASSET_URL = "https://release-assets.githubusercontent.com/github-production/abc";

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
const notFound = () => new Response("Not found", { status: 404 });

async function verify(
  routes: Record<string, Route>,
  extra: { release?: string; download?: string } = {},
) {
  const stub = stubFetch({ [RETIRED_SCRIPT_URL]: notFound, ...routes });
  const reports = await verifyPublishedRemoteAgentScript({
    fetch: stub.fetch,
    expected: SCRIPT,
    timeoutMs: 200,
    ...extra,
  });
  return { reports, seen: stub.seen, code: exitCodeFor(reports) };
}

describe("retired site path", () => {
  it("requires a 404 and sends no identifying request data", async () => {
    const { reports, seen, code } = await verify({});
    expect(code).toBe(0);
    expect(reports.map((report) => report.status)).toEqual(["removed"]);
    const init = seen[0]!.init!;
    expect(init.redirect).toBe("manual");
    expect(init.credentials).toBe("omit");
    expect(Object.keys(init.headers as Record<string, string>).toSorted()).toEqual([
      "accept",
      "user-agent",
    ]);
  });

  it("reports the old HTML fallback or a served script as a mismatch", async () => {
    const html = await verify({
      [RETIRED_SCRIPT_URL]: () =>
        new Response("<!DOCTYPE html><html></html>", {
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    });
    expect(html.code).toBe(1);
    expect(html.reports[0]!.lines.join("\n")).toContain("must return 404");
    expect((await verify({ [RETIRED_SCRIPT_URL]: body(SCRIPT) })).code).toBe(1);
  });

  it("treats other HTTP errors and network failures as unreachable", async () => {
    const server = await verify({ [RETIRED_SCRIPT_URL]: () => new Response("x", { status: 500 }) });
    expect(server.code).toBe(2);
    expect(server.reports[0]!.lines[0]).toContain("HTTP 500");
    const offline = await verifyPublishedRemoteAgentScript({
      fetch: stubFetch({}).fetch,
      expected: SCRIPT,
      timeoutMs: 200,
    });
    expect(exitCodeFor(offline)).toBe(2);
  });

  it("refuses an https-to-http downgrade", async () => {
    const { code } = await verify({
      [RETIRED_SCRIPT_URL]: redirect("http://bigbud.app/remote-agent.sh"),
    });
    expect(code).toBe(1);
  });
});

describe("download links", () => {
  it("follows the link to the release and checks the stamp against the resolved tag", async () => {
    const tagUrl =
      "https://github.com/youpele52/bigbud/releases/download/v0.4.0-beta.6/remote-agent.sh";
    const { reports, code } = await verify(
      {
        [BETA_URL]: redirect(tagUrl),
        [tagUrl]: redirect(ASSET_URL),
        [ASSET_URL]: body(stamped("0.4.0-beta.6")),
      },
      { download: "beta" },
    );
    expect(code).toBe(0);
    expect(reports.map((report) => report.label)).toEqual(["retired site path", "download beta"]);
    expect(reports[1]!.lines.join("\n")).toContain(`via: ${BETA_URL} -> ${tagUrl}`);
  });

  it("reports a stamp that names a different release", async () => {
    const tagUrl =
      "https://github.com/youpele52/bigbud/releases/download/v0.4.0-beta.6/remote-agent.sh";
    const { reports, code } = await verify(
      { [BETA_URL]: redirect(tagUrl), [tagUrl]: body(stamped("0.4.0-beta.5")) },
      { download: "beta" },
    );
    expect(code).toBe(1);
    expect(reports[1]!.lines.join("\n")).toContain('expected stamp: "0.4.0-beta.6"');
  });

  it("refuses a redirect to raw.githubusercontent.com and says why", async () => {
    const raw = "https://raw.githubusercontent.com/youpele52/bigbud/main/remote-agent.sh";
    const { reports, seen, code } = await verify(
      { [BETA_URL]: redirect(raw), [raw]: body(SCRIPT) },
      { download: "beta" },
    );
    expect(code).toBe(1);
    expect(seen.map((entry) => entry.url)).not.toContain(raw);
    expect(reports[1]!.lines.join("\n")).toMatch(/disallowed location[\s\S]*moving branch/);
  });

  it("explains an HTML page served in place of the script", async () => {
    const { reports, code } = await verify(
      {
        [BETA_URL]: () =>
          new Response("<!DOCTYPE html><html></html>", {
            headers: { "content-type": "text/html; charset=utf-8" },
          }),
      },
      { download: "beta" },
    );
    expect(code).toBe(1);
    expect(reports[1]!.lines.join("\n")).toContain("not deployed at this URL");
  });

  it("reports a channel 404 as unreachable", async () => {
    const { reports, code } = await verify({ [BETA_URL]: notFound }, { download: "beta" });
    expect(code).toBe(2);
    expect(reports[1]!.lines[0]).toContain("HTTP 404");
  });

  it("treats a redirect loop as unreachable", async () => {
    const { reports, code } = await verify(
      { [BETA_URL]: redirect(BETA_URL) },
      { download: "beta" },
    );
    expect(code).toBe(2);
    expect(reports[1]!.lines[0]).toContain("more than 5 redirects");
  });
});

describe("release assets", () => {
  it("checks the release asset through GitHub's download hosts", async () => {
    const { reports, code } = await verify(
      { [RELEASE_URL]: redirect(ASSET_URL), [ASSET_URL]: body(stamped("1.2.3")) },
      { release: "1.2.3" },
    );
    expect(code).toBe(0);
    expect(reports.map((report) => report.label)).toEqual(["retired site path", "release 1.2.3"]);
  });

  it("reports a content mismatch with both hashes", async () => {
    const { reports, code } = await verify(
      { [RELEASE_URL]: body("#!/bin/sh\nold\n") },
      { release: "v1.2.3" },
    );
    expect(code).toBe(1);
    expect(formatReports(SCRIPT, reports)).toMatch(
      /release v1\.2\.3: MISMATCH[\s\S]*stamp: missing[\s\S]*expected: [0-9a-f]{64}/,
    );
  });

  it("reports an unstamped release copy", async () => {
    const { reports, code } = await verify({ [RELEASE_URL]: body(SCRIPT) }, { release: "v1.2.3" });
    expect(code).toBe(1);
    expect(reports[1]!.lines.join("\n")).toContain('expected stamp: "1.2.3"');
  });

  it("rejects oversize content by declared length and while streaming", async () => {
    const declared = await verify(
      {
        [RELEASE_URL]: () =>
          new Response("x", { headers: { "content-length": String(10 * 1024 * 1024) } }),
      },
      { release: "1.2.3" },
    );
    expect(declared.code).toBe(1);
    expect(declared.reports[1]!.lines[0]).toContain("exceeds");
    let pulls = 0;
    const streamed = await verify(
      {
        [RELEASE_URL]: () =>
          new Response(
            new ReadableStream({
              pull(controller) {
                pulls += 1;
                controller.enqueue(new Uint8Array(64 * 1024));
              },
            }),
          ),
      },
      { release: "1.2.3" },
    );
    expect(streamed.code).toBe(1);
    expect(pulls).toBeLessThan(10);
  });

  it("reports a timeout as unreachable", async () => {
    const { reports, code } = await verify(
      {
        [RELEASE_URL]: (init) =>
          new Promise<Response>((_, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      },
      { release: "1.2.3" },
    );
    expect(code).toBe(2);
    expect(reports[1]!.lines[0]).toContain("timed out after 200 ms");
  });
});

describe("argument parsing", () => {
  it("parses flags and validates values", () => {
    expect(parseArgs(["--release", "v1.2.3", "--download=beta", "--timeout-ms=500"])).toEqual({
      help: false,
      release: "v1.2.3",
      download: "beta",
      timeoutMs: 500,
    });
    expect(() => parseArgs(["--timeout-ms", "0"])).toThrow(/between/);
    expect(() => parseArgs(["--bogus", "x"])).toThrow(/Unknown argument/);
    expect(() => parseArgs(["--release"])).toThrow(/requires a value/);
    expect(() => parseArgs(["--download", "../x"])).toThrow(/--download must be/);
  });

  it("builds URLs only from safe inputs", () => {
    expect(releaseScriptUrl("youpele52/bigbud", "1.2.3")).toBe(RELEASE_URL);
    expect(() => releaseScriptUrl("a/b/c", "1.2.3")).toThrow(/owner\/repository/);
    expect(() => releaseScriptUrl("a/b", "../x")).toThrow(/version tag/);
    expect(downloadUrl("0.4.0-beta.6")).toBe(
      "https://bigbud.app/download/0.4.0-beta.6/remote-agent",
    );
    expect(() => downloadUrl("beta/../x")).toThrow(/--download must be/);
  });
});
