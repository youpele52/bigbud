/** Standalone UI for the isolated Bun development server, not the production picker. */
export function renderDevSshOwnerPickerPage(
  sessionToken: string,
  executionTargetId: string,
  displayTarget: string,
): string {
  // Prevent HTML parsing from treating embedded configuration as closing script markup.
  const config = JSON.stringify({ sessionToken, executionTargetId, displayTarget }).replaceAll(
    "<",
    "\\u003c",
  );

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>Rust SSH owner · dev folder picker</title>
  <style>
    :root { color-scheme: light dark; font: 14px/1.5 system-ui, sans-serif; }
    body { margin: 0; padding: clamp(1rem, 4vw, 3rem); }
    main { max-width: 46rem; margin-inline: auto; }
    h1 { font-size: 1.5rem; margin: .25rem 0; }
    h2 { font-size: 1.1rem; margin: 0 0 .5rem; }
    section { border: 1px solid GrayText; border-radius: .65rem; padding: 1rem; margin-block: 1rem; }
    .row { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; }
    .muted { font-size: .875rem; }
    .badge { display: inline-block; border: 1px solid; border-radius: 2rem; padding: .1rem .6rem; }
    button, input { font: inherit; padding: .4rem .65rem; }
    button { cursor: pointer; }
    button:disabled { cursor: default; }
    input { flex: 1 1 15rem; min-width: 0; }
    code { overflow-wrap: anywhere; white-space: pre-wrap; }
    #feedback { min-height: 1.5em; }
    #feedback[data-tone="error"] { color: light-dark(#a32121, #ff9a9a); }
    #feedback[data-tone="warning"] { color: light-dark(#825200, #ffce74); }
    #feedback[data-tone="working"] { color: light-dark(#1953a0, #8fbaff); }
    #feedback[data-tone="done"] { color: light-dark(#23622d, #93d99e); }
    #trust-panel { border-color: light-dark(#825200, #ffce74); }
    #folders { padding: 0; max-height: 22rem; overflow: auto; list-style: none; }
    #folders li + li { margin-top: .25rem; }
    #folders button { width: 100%; text-align: start; overflow-wrap: anywhere; white-space: pre-wrap; }
  </style>
</head>
<body>
<main>
  <span class="badge">Rust SSH owner</span>
  <h1>Development folder picker</h1>
  <p>Bound loopback fixture: <code id="target"></code></p>
  <p class="muted">Only this target is available. No SSH fallback.</p>

  <section aria-labelledby="connection-heading">
    <h2 id="connection-heading">Connection</h2>
    <p id="connection" role="status">Not connected in this page.</p>
    <div class="row">
      <button type="button" id="connect" disabled>Connect</button>
      <button type="button" id="disconnect" disabled>Disconnect</button>
      <button type="button" id="restart" disabled>Restart Rust owner</button>
      <button type="button" id="status" disabled>Check status</button>
    </div>
  </section>

  <p id="feedback" role="status"></p>
  <section id="trust-panel" aria-labelledby="trust-heading" hidden>
    <h2 id="trust-heading">Verify SSH host key</h2>
    <p>Compare this fingerprint with the fixture’s known fingerprint before approving it.</p>
    <dl>
      <dt>Host</dt><dd><code id="trust-host"></code></dd>
      <dt>Key type</dt><dd><code id="trust-key-type"></code></dd>
      <dt>Fingerprint</dt><dd><code id="trust-fingerprint" dir="ltr"></code></dd>
    </dl>
    <div class="row">
      <button type="button" id="trust">Trust this exact fingerprint</button>
      <button type="button" id="cancel-trust">Cancel</button>
    </div>
  </section>

  <section aria-labelledby="folder-heading">
    <h2 id="folder-heading">Remote folders</h2>
    <form id="path-form" role="search" aria-label="Remote folder path">
      <label for="path">Remote path</label>
      <div class="row">
        <input id="path" type="text" value="~" maxlength="4096" autocomplete="off" spellcheck="false" disabled>
        <button id="list" type="submit" disabled>Verify and list</button>
      </div>
    </form>
    <p class="muted">Use an absolute path, ~, or ~/folder. Listing verifies access to the resolved path.</p>
    <div class="row">
      <button type="button" id="home" disabled>Home</button>
      <button type="button" id="up" disabled>Up</button>
    </div>
    <p id="listing" hidden>Verified folder: <code id="resolved-path"></code></p>
    <ul id="folders" aria-label="Folders in verified path"></ul>
    <p id="listing-note" hidden></p>
  </section>
</main>
<script>
(() => {
  "use strict";
  const { sessionToken, executionTargetId, displayTarget } = ${config};
  const pageUrl = new URL(window.location.href);
  const token = sessionToken || pageUrl.hash.slice(1);
  if (pageUrl.hash) {
    pageUrl.hash = "";
    history.replaceState(history.state, "", pageUrl);
  }

  const byId = (id) => document.getElementById(id);
  byId("target").textContent = displayTarget;
  const connect = byId("connect");
  const disconnect = byId("disconnect");
  const restart = byId("restart");
  const status = byId("status");
  const feedback = byId("feedback");
  const trustPanel = byId("trust-panel");
  const trust = byId("trust");
  const cancelTrust = byId("cancel-trust");
  const path = byId("path");
  const list = byId("list");
  const home = byId("home");
  const up = byId("up");
  const folders = byId("folders");
  const resolvedPath = byId("resolved-path");
  const listingNote = byId("listing-note");
  let state = "initial";
  let busy = false;
  let approval;
  let currentPath;
  let homePath;

  function sync() {
    const unavailable = !token || busy;
    const browsing = unavailable || state !== "connected" || Boolean(approval);
    connect.disabled = unavailable || state === "connected" || Boolean(approval);
    disconnect.disabled = unavailable || state === "disconnected";
    restart.disabled = unavailable;
    status.disabled = unavailable;
    trust.disabled = cancelTrust.disabled = unavailable || !approval;
    path.disabled = list.disabled = browsing;
    home.disabled = browsing || (Boolean(currentPath) && currentPath === homePath);
    up.disabled = browsing || !currentPath || currentPath === "/";
    for (const button of folders.querySelectorAll("button")) button.disabled = browsing;
  }

  function report(message, tone) {
    feedback.textContent = message;
    feedback.dataset.tone = tone;
  }

  function setConnection(value) {
    state = value;
    byId("connection").textContent = {
      connected: "Connected (owner enabled; verify a path to check SSH access).",
      disconnected: "Disconnected.",
      unknown: "Connection state unconfirmed. Check status or choose Connect or Disconnect.",
    }[value];
  }

  function clearApproval() {
    approval = undefined;
    trustPanel.hidden = true;
  }

  function clearListing() {
    currentPath = homePath = undefined;
    byId("listing").hidden = true;
    listingNote.hidden = true;
    folders.replaceChildren();
  }

  async function post(action, input) {
    const response = await fetch("/api/" + action, {
      method: "POST",
      mode: "same-origin",
      credentials: "omit",
      redirect: "error",
      headers: { "Content-Type": "application/json", "x-bigbud-picker-token": token },
      body: JSON.stringify({ ...input, executionTargetId }),
    });
    const result = await response.json();
    if (result?.ok === false && typeof result.message === "string") return result;
    if (!response.ok || result?.ok !== true) throw new Error("Invalid picker response");
    return result;
  }

  function showFailure(result, retryLabel) {
    const challenge = result.challenge;
    if (retryLabel && challenge && [challenge.challengeId, challenge.host, challenge.keyType,
      challenge.fingerprint].every((value) => typeof value === "string" && value.length > 0)) {
      approval = { challengeId: challenge.challengeId, retryLabel };
      byId("trust-host").textContent = challenge.host;
      byId("trust-key-type").textContent = challenge.keyType;
      byId("trust-fingerprint").textContent = challenge.fingerprint;
      report("SSH host approval required. Compare the exact fingerprint below.", "warning");
      trustPanel.hidden = false;
    } else {
      report(result.message, "error");
    }
  }

  async function run(message, operation, onFailure) {
    if (!token || busy) return;
    busy = true;
    sync();
    report(message, "working");
    try {
      await operation();
    } catch {
      onFailure?.();
      report("The picker could not confirm the Rust SSH owner response. No fallback was attempted.", "error");
    } finally {
      busy = false;
      sync();
      if (approval) trust.focus();
    }
  }

  function connectionAction(action, pending, done, expectedDisconnected) {
    void run(pending, async () => {
      clearApproval();
      clearListing();
      const result = await post(action);
      if (!result.ok) {
        setConnection("unknown");
        showFailure(result, action === "connect" ? "Connect" : undefined);
        return;
      }
      const disconnected = result.value?.disconnected;
      if (typeof disconnected !== "boolean" ||
          (expectedDisconnected !== undefined && disconnected !== expectedDisconnected)) {
        throw new Error("Invalid connection result");
      }
      setConnection(disconnected ? "disconnected" : "connected");
      report(done + (disconnected ? " Target is disconnected." : " Target is enabled."), "done");
    }, () => setConnection("unknown"));
  }

  function listPath(requestedPath) {
    if (state !== "connected" || approval || busy) return;
    path.value = requestedPath;
    void run("Verifying and listing remote folders…", async () => {
      clearListing();
      const result = await post("list", requestedPath ? { path: requestedPath } : {});
      if (!result.ok) {
        showFailure(result, "Verify and list");
        return;
      }
      const value = result.value;
      if (!value || typeof value.path !== "string" || !value.path.startsWith("/") ||
          typeof value.homePath !== "string" || !value.homePath.startsWith("/") ||
          !Array.isArray(value.folders) || typeof value.truncated !== "boolean" ||
          !value.folders.every((folder) => typeof folder?.name === "string" && folder.name &&
            folder.name !== "." && folder.name !== ".." && !folder.name.includes("/") &&
            typeof folder.isGitRepo === "boolean")) {
        throw new Error("Invalid folder listing");
      }
      currentPath = value.path;
      homePath = value.homePath;
      path.value = currentPath;
      resolvedPath.textContent = currentPath;
      byId("listing").hidden = false;
      for (const folder of value.folders) {
        const item = document.createElement("li");
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = folder.name + (folder.isGitRepo ? " (Git repository)" : "");
        button.addEventListener("click", () => listPath(value.path.replace(/\\/$/, "") + "/" + folder.name));
        item.append(button);
        folders.append(item);
      }
      listingNote.hidden = false;
      listingNote.textContent = value.truncated ? "Listing truncated. Enter a path to open folders not shown."
        : value.folders.length === 0 ? "No subfolders." : "";
      report("Remote folder access verified.", "done");
    });
  }

  connect.addEventListener("click", () => connectionAction("connect", "Connecting…", "Connect confirmed.", false));
  disconnect.addEventListener("click", () => connectionAction("disconnect", "Disconnecting…", "Disconnect confirmed.", true));
  restart.addEventListener("click", () => connectionAction("restart-owner", "Restarting Rust owner…", "Rust owner restarted."));
  status.addEventListener("click", () => connectionAction("status", "Checking connection status…", "Status confirmed."));
  byId("path-form").addEventListener("submit", (event) => {
    event.preventDefault();
    listPath(path.value);
  });
  home.addEventListener("click", () => listPath(homePath ?? "~"));
  up.addEventListener("click", () => {
    if (!currentPath || currentPath === "/") return;
    const directory = currentPath.replace(/\\/$/, "");
    listPath(directory.slice(0, directory.lastIndexOf("/")) || "/");
  });
  trust.addEventListener("click", () => {
    if (!approval) return;
    const { challengeId, retryLabel } = approval;
    void run("Submitting approval for the displayed fingerprint…", async () => {
      clearApproval();
      const result = await post("trust", { challengeId });
      if (!result.ok) {
        showFailure(result);
        return;
      }
      report("Fingerprint approved. Choose " + retryLabel + " to retry.", "done");
    }).then(() => (retryLabel === "Connect" ? connect : list).focus());
  });
  cancelTrust.addEventListener("click", () => {
    clearApproval();
    report("Host fingerprint was not approved.", "warning");
    sync();
    (state === "connected" ? list : connect).focus();
  });

  if (!token) report("Missing picker session token. Open the URL printed by the dev server.", "error");
  sync();
})();
</script>
</body>
</html>`;
}
