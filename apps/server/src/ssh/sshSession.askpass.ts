import fs from "node:fs";
import path from "node:path";

/** Askpass that answers only an SSH password/passcode prompt, never a trust prompt. */
export function writePasswordAskpassScript(directoryPath: string): string {
  const scriptPath = path.join(directoryPath, "askpass.sh");
  fs.writeFileSync(
    scriptPath,
    '#!/bin/sh\ncase "$1" in\n  *authenticity*|*fingerprint*) exit 1 ;;\n  *[Pp]assword*|*[Pp]asscode*) printf "%s\\n" "$BIGBUD_SSH_PASSWORD" ;;\n  *) exit 1 ;;\nesac\n',
    "utf8",
  );
  fs.chmodSync(scriptPath, 0o700);
  return scriptPath;
}
