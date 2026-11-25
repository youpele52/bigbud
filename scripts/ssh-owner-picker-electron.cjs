const { app, BrowserWindow } = require("electron");

const pickerUrl = process.env.BIGBUD_SSH_OWNER_PICKER_URL;
const profile = process.env.BIGBUD_SSH_OWNER_PICKER_PROFILE;
delete process.env.BIGBUD_SSH_OWNER_PICKER_URL;
delete process.env.BIGBUD_SSH_OWNER_PICKER_PROFILE;

const url = URL.parse(pickerUrl ?? "");
if (
  !url ||
  (url.protocol !== "http:" && url.protocol !== "https:") ||
  url.hostname !== "127.0.0.1" ||
  url.username !== "" ||
  url.password !== "" ||
  url.hash.length <= 1 ||
  !profile
) {
  app.exit(1);
} else {
  app.setName("bigbud SSH picker");
  app.setPath("userData", profile);
  app.setPath("sessionData", profile);
  app.on("window-all-closed", () => app.quit());
  process.once("SIGINT", () => app.quit());
  process.once("SIGTERM", () => app.quit());

  app
    .whenReady()
    .then(async () => {
      const window = new BrowserWindow({
        width: 1040,
        height: 760,
        show: false,
        title: "bigbud SSH picker",
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          webviewTag: false,
          devTools: false,
        },
      });
      const contents = window.webContents;
      contents.session.setPermissionCheckHandler(() => false);
      contents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
        callback(false),
      );
      contents.session.on("will-download", (event) => event.preventDefault());
      contents.setWindowOpenHandler(() => ({ action: "deny" }));
      contents.on("will-attach-webview", (event) => event.preventDefault());
      const restrictNavigation = (event) => {
        if (!event.isMainFrame || URL.parse(event.url)?.origin !== url.origin) {
          event.preventDefault();
        }
      };
      contents.on("will-frame-navigate", restrictNavigation);
      contents.on("will-redirect", restrictNavigation);
      await window.loadURL(pickerUrl);
      window.show();
    })
    .catch(() => app.exit(1));
}
