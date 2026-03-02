import { randomBytes } from "node:crypto";
import { BrowserWindow, ipcMain } from "electron";

const PROMPT_WIDTH = 420;
const PROMPT_HEIGHT = 188;

function createPromptHtml(input: {
  message: string;
  defaultValue: string;
  submitChannel: string;
  cancelChannel: string;
}): string {
  const scriptConfig = JSON.stringify(input);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1.0" />
    <title>${input.message}</title>
    <style>
      :root {
        color-scheme: light dark;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        --bg: #fff;
        --fg: #1a1a1a;
        --muted: #6b6b6b;
        --border: #d4d4d4;
        --input-bg: #fafafa;
        --focus-ring: rgba(59, 130, 246, 0.5);
        --btn-bg: #f5f5f5;
        --btn-hover: #e8e8e8;
        --btn-primary-bg: #171717;
        --btn-primary-fg: #fff;
        --btn-primary-hover: #333;
      }
      @media (prefers-color-scheme: dark) {
        :root {
          --bg: #1e1e1e;
          --fg: #e4e4e4;
          --muted: #999;
          --border: #3a3a3a;
          --input-bg: #2a2a2a;
          --focus-ring: rgba(96, 165, 250, 0.5);
          --btn-bg: #333;
          --btn-hover: #404040;
          --btn-primary-bg: #e4e4e4;
          --btn-primary-fg: #1a1a1a;
          --btn-primary-hover: #d0d0d0;
        }
      }
      * { box-sizing: border-box; margin: 0; }
      body {
        padding: 16px;
        background: var(--bg);
        color: var(--fg);
        -webkit-font-smoothing: antialiased;
      }
      p {
        margin-bottom: 10px;
        font-size: 13px;
        font-weight: 500;
      }
      input {
        width: 100%;
        padding: 7px 10px;
        font-size: 13px;
        font-family: inherit;
        color: var(--fg);
        background: var(--input-bg);
        border: 1px solid var(--border);
        border-radius: 6px;
        outline: none;
        transition: border-color 0.15s, box-shadow 0.15s;
      }
      input:focus {
        border-color: var(--focus-ring);
        box-shadow: 0 0 0 2px var(--focus-ring);
      }
      .buttons {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        margin-top: 14px;
      }
      button {
        min-width: 72px;
        padding: 6px 14px;
        font-size: 12px;
        font-family: inherit;
        font-weight: 500;
        border: 1px solid var(--border);
        border-radius: 6px;
        cursor: pointer;
        background: var(--btn-bg);
        color: var(--fg);
        transition: background 0.15s;
      }
      button:hover { background: var(--btn-hover); }
      button:active { opacity: 0.85; }
      button[type="submit"] {
        background: var(--btn-primary-bg);
        color: var(--btn-primary-fg);
        border-color: var(--btn-primary-bg);
      }
      button[type="submit"]:hover { background: var(--btn-primary-hover); }
    </style>
  </head>
  <body>
    <p id="message"></p>
    <form id="form">
      <input id="value" autocomplete="off" />
      <div class="buttons">
        <button id="cancel" type="button">Cancel</button>
        <button type="submit">Save</button>
      </div>
    </form>
    <script>
      const { ipcRenderer } = require("electron");
      const config = ${scriptConfig};
      const message = document.getElementById("message");
      const form = document.getElementById("form");
      const valueInput = document.getElementById("value");
      const cancelButton = document.getElementById("cancel");

      message.textContent = config.message;
      valueInput.value = config.defaultValue;

      function cancel() {
        ipcRenderer.send(config.cancelChannel);
        window.close();
      }

      form.addEventListener("submit", (event) => {
        event.preventDefault();
        ipcRenderer.send(config.submitChannel, valueInput.value);
        window.close();
      });
      cancelButton.addEventListener("click", cancel);
      window.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          cancel();
        }
      });
      window.addEventListener("DOMContentLoaded", () => {
        valueInput.focus();
        valueInput.select();
      });
    </script>
  </body>
</html>`;
}

export async function showDesktopPromptDialog(
  message: string,
  defaultValue: string,
  ownerWindow: BrowserWindow | null,
): Promise<string | null> {
  const normalizedMessage = message.trim();
  if (normalizedMessage.length === 0) {
    return null;
  }

  const token = randomBytes(12).toString("hex");
  const submitChannel = `desktop:prompt-dialog:submit:${token}`;
  const cancelChannel = `desktop:prompt-dialog:cancel:${token}`;

  const promptWindow = new BrowserWindow({
    width: PROMPT_WIDTH,
    height: PROMPT_HEIGHT,
    useContentSize: true,
    show: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    title: normalizedMessage,
    ...(ownerWindow ? { parent: ownerWindow } : {}),
    modal: ownerWindow !== null,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });
  promptWindow.removeMenu();

  return new Promise<string | null>((resolve) => {
    let settled = false;

    const settle = (value: string | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };

    const cleanup = () => {
      ipcMain.removeAllListeners(submitChannel);
      ipcMain.removeAllListeners(cancelChannel);
      if (!promptWindow.isDestroyed()) {
        promptWindow.destroy();
      }
    };

    ipcMain.once(submitChannel, (_event, value: unknown) => {
      if (typeof value !== "string") {
        settle(null);
        return;
      }
      settle(value);
    });
    ipcMain.once(cancelChannel, () => settle(null));
    promptWindow.once("closed", () => settle(null));

    const html = createPromptHtml({
      message: normalizedMessage,
      defaultValue,
      submitChannel,
      cancelChannel,
    });
    void promptWindow
      .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
      .then(() => {
        if (!promptWindow.isDestroyed()) {
          promptWindow.show();
        }
      })
      .catch(() => settle(null));
  });
}
