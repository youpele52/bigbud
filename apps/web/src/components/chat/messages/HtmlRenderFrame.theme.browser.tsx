import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { HtmlRenderFrame } from "./HtmlRenderFrame";

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const reports: Array<Record<string, unknown>> = [];
const hostStyles = ["--background", "--card", "--foreground", "color-scheme"];
let originalStyles: Array<readonly [string, string]> = [];
function receive(event: MessageEvent) {
  const guard = host.querySelector("iframe")?.contentWindow;
  if (!guard?.length || event.source !== guard[0] || event.data?.type !== "theme-test") return;
  reports.push(event.data);
}
function setHost(values: Record<string, string>) {
  for (const [key, value] of Object.entries(values))
    document.documentElement.style.setProperty(key, value);
}
beforeEach(() => {
  reports.length = 0;
  originalStyles = hostStyles.map(
    (key) => [key, document.documentElement.style.getPropertyValue(key)] as const,
  );
  // Dark-mode-like host tokens: the defaults inside the sandbox would otherwise be white.
  setHost({
    "--background": "rgb(20, 20, 20)",
    "--card": "rgb(30, 30, 30)",
    "--foreground": "rgb(250, 250, 250)",
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  window.addEventListener("message", receive);
});
afterEach(() => {
  root.unmount();
  host.remove();
  window.removeEventListener("message", receive);
  for (const [key, value] of originalStyles) document.documentElement.style.setProperty(key, value);
});

/** Posts computed colours for the given selectors after every theme update. */
function render(title: string, html: string, selectors: string[]) {
  root.render(
    <HtmlRenderFrame
      content={{
        title,
        html: `${html}<script>
      const initial = matchMedia('(prefers-color-scheme: dark)').matches;
      addEventListener('message', (event) => {
        if (event.data?.type !== 'bigbud:html-theme') return;
        setTimeout(() => parent.parent.postMessage({ type:'theme-test', initial,
          dark: matchMedia('(prefers-color-scheme: dark)').matches,
          colors: ${JSON.stringify(selectors)}.map((selector) => getComputedStyle(document.querySelector(selector)).color),
        }, '*'), 0);
      });
    </script>`,
      }}
    />,
  );
}

it("resolves invented names to bigbud only on bigbud surfaces; agent palettes stay intact", async () => {
  render(
    "Surfaces",
    `<style>:root{--text-secondary:rgb(1, 2, 3)} p{color:var(--text-primary,#1f2937)}
      .card{background:#fff} .sub{color:var(--text-secondary,#999)}
      .inner{background:var(--card)}</style>
    <p id="plain">On bigbud</p>
    <div class="card"><p id="own">On agent white</p><p class="sub" id="sub">Agent token</p>
      <div class="inner"><p id="nested">On bigbud card</p></div></div>`,
    ["#plain", "#own", "#sub", "#nested"],
  );
  await expect
    .poll(() => reports.at(-1)?.colors)
    .toEqual(["rgb(250, 250, 250)", "rgb(31, 41, 55)", "rgb(1, 2, 3)", "rgb(250, 250, 250)"]);
});

it("makes prefers-color-scheme and matchMedia follow bigbud's theme, not the OS", async () => {
  setHost({ "color-scheme": "dark" });
  render(
    "Scheme",
    `<style>@media (prefers-color-scheme: dark){#m{color:rgb(1, 1, 1)}}
      @media screen and (prefers-color-scheme: light){#m{color:rgb(2, 2, 2)}}</style><p id="m">M</p>`,
    ["#m"],
  );
  await expect
    .poll(() => reports.at(-1))
    .toMatchObject({ initial: true, dark: true, colors: ["rgb(1, 1, 1)"] });
  setHost({ "color-scheme": "light" });
  await expect.poll(() => reports.at(-1)).toMatchObject({ dark: false, colors: ["rgb(2, 2, 2)"] });
});

it("keeps the agent's own definition of an invented name", async () => {
  render(
    "Aliases",
    `<style>:root{--text-secondary:rgb(1, 2, 3)} body{color:var(--text-primary,#1f2937)}
      .sub{color:var(--text-secondary,#64748b)}</style><p class="sub">Sub</p>`,
    ["body", ".sub"],
  );
  await expect.poll(() => reports.at(-1)?.colors).toEqual(["rgb(250, 250, 250)", "rgb(1, 2, 3)"]);
});
