import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { commands } from "vitest/browser";
import { openLinkFromClick } from "~/lib/openLink";
import { HtmlRenderFrame } from "./HtmlRenderFrame";
import { buildHtmlRenderGuard } from "./HtmlRenderFrame.guard";

vi.mock("~/lib/openLink", () => ({ openLinkFromClick: vi.fn() }));

declare module "vitest/browser" {
  interface BrowserCommands {
    checkHtmlRenderLinkClick: (
      document: string,
      selector: string,
    ) => Promise<{
      messages: unknown[];
      remainingFrames: number;
      notices: number;
      requests: string[];
    }>;
    clickHtmlRenderLinks: (title: string, selectors: string[]) => Promise<void>;
  }
}

const href = "https://render-leak.invalid/source?secret=content";
const relayed = [{ type: "bigbud:open-link", href }];

it.each([
  ["an HTML anchor", `<a href="${href}">Source</a>`, "a", relayed],
  [
    "an SVG xlink anchor",
    `<svg width="120" height="24"><a xlink:href="${href}"><text x="0" y="16">Source</text></a></svg>`,
    "svg a",
    relayed,
  ],
  [
    "an anchor in an open shadow root",
    `<div id="host"></div><script>document.getElementById('host').attachShadow({mode:'open'}).innerHTML = '<a href="${href}">Source</a>';</script>`,
    "a",
    relayed,
  ],
  ["a same-document fragment link", `<a href="#end">Jump</a><p id="end">End</p>`, "a", []],
])(
  "relays a real click on %s without navigating or hiding the visual",
  async (_, html, selector, messages) => {
    expect(await commands.checkHtmlRenderLinkClick(buildHtmlRenderGuard(html), selector)).toEqual({
      messages,
      remainingFrames: 1,
      notices: 0,
      requests: [],
    });
  },
);

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const events: Array<{ type: string; y?: number; hash?: string; style?: string }> = [];
function receive(event: MessageEvent) {
  // Read length first: indexing a missing cross-origin child frame throws.
  const guard = host.querySelector("iframe")?.contentWindow;
  if (!guard?.length || event.source !== guard[0]) return;
  if (typeof event.data?.type === "string") events.push(event.data);
}
beforeEach(() => {
  vi.mocked(openLinkFromClick).mockClear();
  events.length = 0;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  window.addEventListener("message", receive);
});
afterEach(() => {
  root.unmount();
  host.remove();
  window.removeEventListener("message", receive);
});

const links = `<a id="js" href="javascript:parent.parent.postMessage({type:'render-test-js'},'*')">js</a>
  <a id="file" href="file:///etc/hosts">file</a> <a id="data" href="data:text/html,leak">data</a>
  <a id="web" href="https://example.com/source?a=1">web</a> <a id="frag" href="#target">frag</a>
  <div style="height:2000px"></div><p id="target">target</p>`;

it("opens only clicked web links through openLink, rate-limited, and keeps the visual intact", async () => {
  root.render(
    <HtmlRenderFrame
      content={{
        title: "Links",
        html: `${links}<script>
      addEventListener('message', (event) => { if (event.data?.type === 'bigbud:html-theme') parent.parent.postMessage({type:'render-test-ready'}, '*'); });
      addEventListener('scroll', () => parent.parent.postMessage({type:'render-test-scroll', y:scrollY}, '*'));
      addEventListener('hashchange', () => parent.parent.postMessage({type:'render-test-hash', hash:location.hash}, '*'));
    </script>`,
      }}
    />,
  );
  await expect.poll(() => events.map((event) => event.type)).toContain("render-test-ready");
  await commands.clickHtmlRenderLinks("Links", ["#js", "#file", "#data", "#web", "#web", "#frag"]);
  // A fragment link jumps inside the visual: hash updates, it scrolls, and nothing is opened.
  await expect.poll(() => events).toContainEqual({ type: "render-test-hash", hash: "#target" });
  await expect
    .poll(() => events.some((event) => event.type === "render-test-scroll" && event.y! > 0))
    .toBe(true);
  expect(host.querySelector("iframe")?.contentWindow?.length).toBe(1);
  expect(events.map((event) => event.type)).not.toContain("render-test-js");
  expect(openLinkFromClick).toHaveBeenCalledTimes(1);
  expect(openLinkFromClick).toHaveBeenCalledWith("https://example.com/source?a=1");
});

it("ignores script-initiated link clicks that carry no user gesture", async () => {
  root.render(
    <HtmlRenderFrame
      content={{
        title: "Scripted",
        html: `${links}<script>
      addEventListener('message', function once(event) {
        if (event.data?.type !== 'bigbud:html-theme') return;
        removeEventListener('message', once);
        for (const id of ['js', 'file', 'data', 'web']) document.getElementById(id).click();
        parent.postMessage({type:'bigbud:open-link', href:'https://example.com/direct'}, '*');
        setTimeout(() => parent.parent.postMessage({type:'render-test-alive'}, '*'), 300);
      });
    </script>`,
      }}
    />,
  );
  await expect.poll(() => events.map((event) => event.type)).toContain("render-test-alive");
  expect(events.map((event) => event.type)).not.toContain("render-test-js");
  expect(openLinkFromClick).not.toHaveBeenCalled();
});

it("lets an agent's plain link rule override the default link styling", async () => {
  root.render(
    <HtmlRenderFrame
      content={{
        title: "Styled",
        html: `<style>a { color: rgb(9, 8, 7); text-decoration: none; }</style><a href="https://example.com">x</a><script>
      addEventListener('message', (event) => {
        if (event.data?.type !== 'bigbud:html-theme') return;
        const style = getComputedStyle(document.querySelector('a'));
        parent.parent.postMessage({type:'render-test-style', style:[style.color, style.textDecorationLine].join('|')}, '*');
      });
    </script>`,
      }}
    />,
  );
  await expect
    .poll(() => events.find((event) => event.type === "render-test-style"))
    .toMatchObject({ style: "rgb(9, 8, 7)|none" });
});
