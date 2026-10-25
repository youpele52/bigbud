import { execFile } from "node:child_process";
import { promisify } from "node:util";

const executeFile = promisify(execFile);
let currentSid;

/** Elevated CI tokens default to Administrators ownership; set only disposable fixtures to the user. */
export async function ownV2WindowsFixture(root) {
  if (process.platform !== "win32") return;
  currentSid ??= executeFile("whoami.exe", ["/user", "/fo", "csv", "/nh"], {
    encoding: "utf8",
    timeout: 5000,
  }).then(({ stdout }) => {
    const sid = stdout.match(/\bS-1-5-(?:\d+-)*\d+\b/)?.[0];
    if (!sid) throw new Error("Disposable Windows fixture user unavailable.");
    return sid;
  });
  await executeFile("icacls.exe", [root, "/setowner", `*${await currentSid}`, "/T", "/Q"], {
    timeout: 5000,
  });
}
