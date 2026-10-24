/** Chromium-generated gestures through unmodified production input listeners.
 * This is not a physical trackpad check.
 * Run: bun run --cwd apps/desktop scripts/browser-smoke.mjs src/window/browserHistoryGestures.smoke.ts
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { app, BrowserWindow, type WebContents } from "electron";
import { hardenBrowserGuestPreferences } from "./browserGuestPreferences";
import { bindBrowserPopups } from "./browserPopups";
import { BROWSER_SESSION_PARTITION, initializeBrowserSession } from "./browserSession";

const outputDir = process.env.BIGBUD_BROWSER_SMOKE_DIR;
assert.ok(outputDir);
assert.equal(process.platform, "darwin", "This native gesture smoke requires macOS.");
app.setPath("userData", join(outputDir, "profile"));
app.on("window-all-closed", () => {
  /* The fixture owns completion. */
});

async function until(label: string, check: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await check()) return;
    await delay(10);
  }
  throw new Error(`Timed out: ${label}`);
}

async function verify(): Promise<void> {
  await app.whenReady();
  const fixture = `<style>html,body{margin:0;width:100%;height:100%}.scroller{position:absolute;left:10px;top:100px;width:300px;height:80px;overflow-x:auto}.wide{width:1200px;height:60px;background:lightblue}#handled{position:absolute;top:200px;width:300px;height:60px}#contained{position:absolute;top:280px;width:300px;height:60px;overflow-x:auto;overscroll-behavior-x:contain}textarea{position:absolute;top:360px}</style>
    <div id="plain">Page</div><div class="scroller" id="scroller"><div class="wide">Horizontal content</div></div><div id="handled">Site-handled gesture</div><div id="contained"><div class="wide">No overscroll navigation</div></div><textarea>Editing</textarea>
    <script>window.wheels=[];addEventListener('wheel',event=>wheels.push({x:event.deltaX,y:event.deltaY,trusted:event.isTrusted,buttons:event.buttons,mode:event.deltaMode,focus:document.hasFocus()}));document.querySelector('#handled').addEventListener('wheel',event=>event.preventDefault(),{passive:false});</script>`;
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "text/html");
    response.end(
      request.url === "/host"
        ? `<style>body{margin:0}webview{position:absolute;inset:50px 0 0;width:100%;height:calc(100% - 50px)}</style><button id="chat">Chat</button><webview partition="${BROWSER_SESSION_PARTITION}" src="http://${request.headers.host}/a"></webview>`
        : fixture,
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  initializeBrowserSession();
  const host = new BrowserWindow({
    width: 800,
    height: 600,
    show: true,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
    },
  });
  host.webContents.on("will-attach-webview", (_event, preferences) =>
    hardenBrowserGuestPreferences(preferences),
  );
  host.webContents.on("did-attach-webview", (_event, guest) => bindBrowserPopups(host, guest));
  const attached = once(host.webContents, "did-attach-webview");
  try {
    await host.loadURL(`${origin}/host`);
    const [, guest] = (await attached) as [unknown, WebContents];
    const ready = async () => {
      await until("isolated listener installation", async () =>
        guest.executeJavaScriptInIsolatedWorld(1004, [
          { code: "Boolean(globalThis.__bigbudHistoryGestures)" },
        ]),
      );
      app.focus({ steal: true });
      host.focus();
      await host.webContents.executeJavaScript("document.querySelector('#chat').focus()");
      // macOS window activation is asynchronous; settle it without focusing the guest.
      host.moveTop();
      await delay(200);
      app.focus({ steal: true });
      host.focus();
      await until("active owner window", async () => host.isFocused());
      assert.equal(
        await guest.executeJavaScript("document.hasFocus()"),
        false,
        "Keep keyboard focus outside the guest, like using its toolbar.",
      );
    };
    await ready();
    await guest.loadURL(`${origin}/b`);
    await ready();
    await guest.loadURL(`${origin}/c`);
    await ready();
    const productionListeners = guest.listeners("input-event");
    const events: string[] = [];
    guest.on("input-event", (_event, input) => events.push(input.type));
    host.webContents.debugger.attach("1.3");
    // Address the embedder: Chromium hit-tests and routes input into the guest.
    // Sending this CDP command directly to a webview target delivers no wheels.
    const scroll = (deltaX: number, y = 10, deltaY = 0, x = 40, xOverscroll = 0) =>
      host.webContents.debugger.sendCommand("Input.synthesizeScrollGesture", {
        x,
        y: y + 50,
        xDistance: -deltaX,
        yDistance: -deltaY,
        xOverscroll,
        speed: 800,
        gestureSourceType: "mouse",
        preventFling: true,
      });
    const swipe = async (deltaX: number, y = 10, deltaY = 0, x = 40, xOverscroll = 0) => {
      await delay(1300);
      await ready();
      await scroll(deltaX, y, deltaY, x, xOverscroll);
    };
    assert.equal(
      await guest.executeJavaScript(
        "typeof globalThis.__bigbudHistoryGestures + ':' + typeof require + ':' + typeof window.desktopBridge",
      ),
      "undefined:undefined:undefined",
    );
    await swipe(-250);
    await until("one back step", async () => guest.getURL() === `${origin}/b`);
    await ready();
    assert.equal(guest.navigationHistory.canGoForward(), true);
    assert.ok(
      events.includes("mouseWheel") &&
        events.includes("gestureScrollBegin") &&
        events.includes("gestureScrollEnd"),
      "Chromium must deliver real input-event phases through production listeners.",
    );
    // An immediate native continuation must not skip another history entry.
    await scroll(-250);
    assert.equal(guest.getURL(), `${origin}/b`);
    await swipe(250);
    await until("one forward step", async () => guest.getURL() === `${origin}/c`);
    await ready();
    const assertStayed = async (label: string) => {
      await delay(180);
      assert.equal(guest.getURL(), `${origin}/c`, label);
    };
    await swipe(250, 120);
    await assertStayed("nested horizontal scrolling must win");
    assert.ok(await guest.executeJavaScript("document.querySelector('#scroller').scrollLeft>0"));
    await guest.executeJavaScript("document.querySelector('#scroller').scrollLeft=0");
    await swipe(-250, 120);
    await until(
      "scroller edge yields like native overscroll",
      async () => guest.getURL() === `${origin}/b`,
    );
    guest.navigationHistory.goForward();
    await until("restore forward entry", async () => guest.getURL() === `${origin}/c`);
    await ready();
    await guest.executeJavaScript(
      "const scroller=document.querySelector('#scroller');scroller.scrollLeft=300;scroller.addEventListener('wheel',()=>{scroller.style.top='450px'},{once:true})",
    );
    await swipe(-250, 120);
    await assertStayed("leaving a nested scroller mid-gesture must not navigate");
    await guest.executeJavaScript(
      "document.querySelector('#scroller').style.top='100px';document.querySelector('#scroller').style.direction='rtl'",
    );
    await swipe(-250, 120);
    await assertStayed("RTL nested scrolling must win");
    await guest.executeJavaScript(
      "document.body.style.width='1600px';document.scrollingElement.scrollLeft=300",
    );
    await swipe(-250);
    await assertStayed("page horizontal scrolling must win");
    assert.ok(await guest.executeJavaScript("document.scrollingElement.scrollLeft<300"));
    await guest.executeJavaScript(
      "document.body.style.width='100%';document.scrollingElement.scrollLeft=0;const shadowHost=document.createElement('div');shadowHost.style.cssText='position:absolute;left:350px;top:100px;width:300px;height:80px';document.body.append(shadowHost);shadowHost.attachShadow({mode:'open'}).innerHTML='<div style=\"width:300px;overflow-x:auto\"><div style=\"width:1200px;height:60px\">Shadow scroller</div></div>';shadowHost.shadowRoot.firstChild.scrollLeft=300",
    );
    await swipe(-250, 120, 0, 400);
    await assertStayed("open-shadow nested scrolling must win");
    await swipe(-250, 220);
    await assertStayed("site preventDefault must win");
    await swipe(-250, 300);
    await assertStayed("overscroll-behavior must win");
    await swipe(-250, 380);
    await assertStayed("editing must not navigate");
    await swipe(-250, 10, 150);
    await assertStayed("diagonal scrolling must not navigate");
    await delay(1300);
    await ready();
    await Promise.all([
      scroll(-80),
      guest.executeJavaScript(
        "for(let i=0;i<5;i++)window.dispatchEvent(new WheelEvent('wheel',{deltaX:-100}))",
      ),
    ]);
    await assertStayed("page-generated wheel events must not navigate");
    await swipe(250);
    await assertStayed("unavailable forward history must be a no-op");
    const hostUrl = host.webContents.getURL();
    const guestWheelCount = events.filter((type) => type === "mouseWheel").length;
    await swipe(-250, -30);
    await assertStayed("input over app/chat must not navigate the guest");
    assert.equal(events.filter((type) => type === "mouseWheel").length, guestWheelCount);
    assert.equal(host.webContents.getURL(), hostUrl);
    assert.equal(
      await host.webContents.executeJavaScriptInIsolatedWorld(1004, [
        { code: "typeof globalThis.__bigbudHistoryGestures" },
      ]),
      "undefined",
    );
    assert.ok(
      productionListeners.every((listener) => guest.listeners("input-event").includes(listener)),
      "Do not replace or remove production input listeners.",
    );
    host.webContents.debugger.detach();
    console.log(
      "Native gesture smoke passed: Chromium CDP gestures through unmodified production listeners, toolbar-focused back/forward, one step, immediate-continuation lock, scrollers and edge yield, site handlers, editing, diagonal rejection and isolation. No physical trackpad was tested.",
    );
  } finally {
    if (!host.isDestroyed()) host.destroy();
    server.close();
  }
}

void verify().then(
  () => {
    writeFileSync(join(outputDir, "passed"), "passed\n");
    app.exit(0);
  },
  (error) => {
    console.error(error);
    app.exit(1);
  },
);
