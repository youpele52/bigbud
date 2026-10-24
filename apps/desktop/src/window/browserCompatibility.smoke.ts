/** Local-only native check: bun run --cwd apps/desktop scripts/browser-smoke.mjs */
import assert from "node:assert/strict";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { app, BrowserWindow, dialog, type WebContents } from "electron";
import { hardenBrowserGuestPreferences } from "./browserGuestPreferences";
import { bindBrowserPopups } from "./browserPopups";
import { BROWSER_SESSION_PARTITION, initializeBrowserSession } from "./browserSession";

const outputDir = process.env.BIGBUD_BROWSER_SMOKE_DIR;
assert.ok(outputDir, "The runner must supply a temporary profile directory.");
app.setPath("userData", join(outputDir, "profile"));
app.on("window-all-closed", () => {
  /* The fixture owns process completion. */
});

async function waitUntil(label: string, check: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await check()) return;
    await delay(50);
  }
  throw new Error(`Timed out waiting for native browser fixture: ${label}`);
}

async function verify(): Promise<void> {
  await app.whenReady();
  let postedBody = "";
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "text/html");
    if (request.url === "/host") {
      response.end(
        `<webview partition="${BROWSER_SESSION_PARTITION}" allowpopups src="http://${request.headers.host}/site" style="width:100%;height:100%"></webview>`,
      );
    } else if (request.url === "/site") {
      response.setHeader("Set-Cookie", "browser_smoke=shared; SameSite=Lax; Path=/");
      response.end(
        `<script>window.messages=[];addEventListener('message',event=>{if(event.origin===location.origin)messages.push(event.data)});</script>Browser fixture`,
      );
    } else if (request.url === "/popup") {
      response.end(
        `<script>opener.postMessage({kind:'login',cookie:document.cookie},location.origin)</script>Login popup`,
      );
    } else if (request.url === "/post") {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        postedBody = body;
        response.end("<script>window.close()</script>Form submitted");
      });
    } else {
      response.end("Fixture");
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const browserSession = initializeBrowserSession();
  const host = new BrowserWindow({
    show: false,
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
  const attached = once(host.webContents, "did-attach-webview");
  host.webContents.on("did-attach-webview", (_event, guest) => bindBrowserPopups(host, guest));
  const originalDialog = dialog.showMessageBox;
  const prompts: Electron.MessageBoxOptions[] = [];
  dialog.showMessageBox = (async (_owner: BrowserWindow, options: Electron.MessageBoxOptions) => {
    prompts.push(options);
    return { response: 0, checkboxChecked: false };
  }) as typeof dialog.showMessageBox;
  try {
    await host.loadURL(`${origin}/host`);
    const [, root] = (await attached) as [unknown, WebContents];
    await waitUntil(
      "initial guest load",
      async () =>
        root.getURL() === `${origin}/site` &&
        (await root.executeJavaScript("Array.isArray(window.messages)")),
    );
    assert.equal(root.session, browserSession);
    const created = once(root, "did-create-window");
    assert.equal(
      await root.executeJavaScript(
        `Boolean(window.login=window.open('about:blank','login'))`,
        true,
      ),
      true,
    );
    const [popup] = (await created) as [BrowserWindow];
    assert.equal(popup.webContents.session, browserSession);
    await root.executeJavaScript(`login.location.href=${JSON.stringify(`${origin}/popup`)}`);
    await waitUntil("popup postMessage", async () =>
      root.executeJavaScript("messages.some(message=>message.kind==='login')"),
    );
    const messages = await root.executeJavaScript("messages");
    assert.equal(messages[0].cookie, "browser_smoke=shared");
    assert.equal(root.getURL(), `${origin}/site`, "Popup must not replace the opener.");
    assert.equal(
      await popup.webContents.executeJavaScript(
        "typeof require + ':' + typeof window.desktopBridge",
      ),
      "undefined:undefined",
    );
    const formCreated = once(root, "did-create-window");
    await root.executeJavaScript(
      `const form=document.createElement('form');form.action='/post';form.method='POST';form.target='_blank';const input=document.createElement('input');input.name='proof';input.value='preserved';form.append(input);document.body.append(form);form.submit()`,
      true,
    );
    await waitUntil("POST target-blank", async () => postedBody === "proof=preserved");
    const [formPopup] = (await formCreated) as [BrowserWindow];
    await waitUntil("form window close", async () => formPopup.isDestroyed());
    console.log("Native browser smoke: popup messaging, cookies and POST verified.");
    for (const name of ["second", "third"]) {
      const nextCreated = once(root, "did-create-window");
      await root.executeJavaScript(`window.open('about:blank',${JSON.stringify(name)});true`, true);
      await nextCreated;
    }
    assert.equal(
      await root.executeJavaScript("Boolean(window.open('file:///etc/passwd'))", true),
      false,
    );
    assert.equal(
      await root.executeJavaScript(
        `Boolean(window.open(${JSON.stringify(`${origin}/popup`)}))`,
        true,
      ),
      false,
    );
    await waitUntil("popup limit feedback", async () =>
      prompts.some((prompt) => prompt.message.includes("Popup limit reached")),
    );
    assert.equal(popup.webContents.getURL(), `${origin}/popup`);
    console.log("Native browser smoke: popup protocol policy verified.");
    // Denial exercises the real Chromium permission request without touching OS devices.
    assert.equal(await root.executeJavaScript("Notification.requestPermission()", true), "denied");
    assert.ok(
      prompts.some((prompt) => prompt.message === `Allow ${origin} to show notifications?`),
    );
    assert.equal(
      await root.executeJavaScript(
        "new Promise(resolve=>navigator.geolocation.getCurrentPosition(()=>resolve('allowed'),()=>resolve('denied')))",
        true,
      ),
      "denied",
    );
    assert.ok(
      prompts.some((prompt) => prompt.message === `Allow ${origin} to know your location?`),
    );
    console.log("Native browser smoke: permission denial verified.");
    const closed = once(popup, "closed");
    void popup.webContents.executeJavaScript("window.close()").catch(() => undefined);
    await closed;
    const orphanCreated = once(root, "did-create-window");
    await root.executeJavaScript("window.open('about:blank','orphan');true", true);
    const [orphan] = (await orphanCreated) as [BrowserWindow];
    host.destroy();
    assert.equal(orphan.isDestroyed(), true);
    console.log(
      "Native browser smoke passed: blank popup, shared cookies, opener postMessage, POST target-blank, isolation, popup protocol block, permission denial, window.close, owner cleanup.",
    );
  } finally {
    dialog.showMessageBox = originalDialog;
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
