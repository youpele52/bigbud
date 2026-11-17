import { isAbsolute, join, normalize } from "node:path";
import { hasLocalSupervisorServiceControls } from "./localSupervisorService.paths.ts";

export const LOCAL_SERVICE_UNIT_NAME = /^bigbud-(backend|rust)-([a-f0-9]{32})\.service$/;
/** The backend unit's only other command: after a clean stop it flushes its own start-rate
 * counter (Rust `BACKEND_STOP_POST`). It names no artifact path, so it adds no reference. */
export const LOCAL_SERVICE_BACKEND_STOP_POST =
  "ExecStopPost=-/bin/sh -c 'case $$SERVICE_RESULT in success) exec /usr/bin/systemctl --user --no-ask-password reset-failed $$1;; esac' sh %n";

function unquote(token: string): string {
  let value = "";
  const body = token.slice(1, -1);
  for (let index = 0; index < body.length; index++) {
    const character = body[index]!;
    if (character === "\\") {
      const next = body[++index];
      if (next !== "\\" && next !== '"') throw new Error("Unknown service unit escape.");
      value += next;
    } else if (character === "$" || character === "%") {
      if (body[++index] !== character) throw new Error("Unknown service unit expansion.");
      value += character;
    } else value += character;
  }
  if (!isAbsolute(value) || normalize(value) !== value || hasLocalSupervisorServiceControls(value))
    throw new Error("Service unit contains a noncanonical path.");
  return value;
}

/** Parse only our generated immutable launcher form; unknown user units remain untouched. */
export function localSupervisorServiceUnitReference(text: string, name: string, home: string) {
  const identity = LOCAL_SERVICE_UNIT_NAME.exec(name);
  if (
    !identity ||
    Buffer.byteLength(text) > 64 * 1024 ||
    hasLocalSupervisorServiceControls(text, true)
  )
    throw new Error("Unknown account service unit metadata.");
  const header =
    identity[1] === "rust"
      ? "# bigbud account-service v1; independent Rust terminal owner"
      : "# bigbud account-service v1; user scope only";
  if (text.split("\n")[0] !== header) throw new Error("The unit is user-managed or unsupported.");
  const lines = text.split("\n");
  const stopPost = lines.filter((line) => line === LOCAL_SERVICE_BACKEND_STOP_POST).length;
  if (stopPost > (identity[1] === "backend" ? 1 : 0))
    throw new Error("Unknown service unit command ownership.");
  const commands = lines.filter(
    (line) => line.startsWith("Exec") && line !== LOCAL_SERVICE_BACKEND_STOP_POST,
  );
  if (commands.length !== 1) throw new Error("Unknown service unit command ownership.");
  const command =
    /^ExecStart=("(?:[^"\\]|\\.)*") --backend-service run ("(?:[^"\\]|\\.)*") (backend|rust)$/.exec(
      commands[0]!,
    );
  if (!command || command[3] !== identity[1]) throw new Error("Service unit role is inconsistent.");
  const configPath = unquote(command[2]!);
  if (configPath !== join(home, ".bigbud/backend-services", identity[2]!, "config-v1"))
    throw new Error("Service unit belongs to another account configuration.");
  return { authority: identity[2]!, binaryPath: unquote(command[1]!), configPath };
}
