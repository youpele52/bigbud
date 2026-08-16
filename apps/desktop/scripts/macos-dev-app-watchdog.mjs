import { spawnSync } from "node:child_process";

const watchedPid = Number(process.argv[2]);
const marker = Buffer.from(process.argv[3] ?? "", "base64").toString("utf8");

if (!Number.isInteger(watchedPid) || watchedPid <= 1 || !marker.startsWith("--t3code-dev-root=/")) {
  process.exit(2);
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const timer = setInterval(() => {
  if (isAlive(watchedPid)) {
    return;
  }

  clearInterval(timer);
  // A Launch Services app is not a child of the dev runner. If Turbo or Bun
  // terminates the runner before its cleanup hook runs, stop only the app
  // carrying this repository-specific development marker.
  spawnSync("pkill", ["-TERM", "-f", "--", marker], { stdio: "ignore" });
  process.exit(0);
}, 250);
