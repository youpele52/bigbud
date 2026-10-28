// Fixed safety renderer: only the four bounded preload calls exist here.
"use strict";
const api = window.bigbudComputerUseSafety;
const statusEl = document.getElementById("status");
const noticeEl = document.getElementById("notice");
let noticeId = null;

async function refresh() {
  const status = await api.getStatus();
  if (!status) return;
  statusEl.textContent =
    status.state === "unavailable" ? "Computer use unavailable" : `Computer use ${status.state}`;
  noticeId =
    status.noticeState === "required" || status.noticeState === "presented_unconfirmed"
      ? status.noticeId
      : null;
  noticeEl.hidden = noticeId === null;
}

// Acknowledgement is a human action on the visible notice, never automatic.
document.getElementById("acknowledge").addEventListener("click", () => {
  if (noticeId !== null) void api.acknowledgeWarning(noticeId).then(refresh);
});

// Stop has no confirmation and never waits on anything else in this page.
document.getElementById("stop").addEventListener("click", () => {
  void api.stop().then(refresh);
});
document.getElementById("restrictions").addEventListener("click", () => {
  void api.openRestrictions();
});
void refresh();
setInterval(() => void refresh(), 1000);
