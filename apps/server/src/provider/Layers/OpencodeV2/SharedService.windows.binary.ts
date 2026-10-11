import { execFile } from "node:child_process";
import { promisify } from "node:util";

const executeFile = promisify(execFile);

/** Old agents ignore unknown mode flags; only their side-effect-free --check may precede admission. */
export async function verifyV2InspectionCapability(
  binary: string,
  deadline: number,
  signal: AbortSignal,
): Promise<void> {
  const timeout = deadline - Date.now();
  if (timeout <= 0) throw new Error("Native inspection deadline exceeded.");
  try {
    const { stdout } = await executeFile(binary, ["--check", "--capabilities"], {
      encoding: "utf8",
      timeout,
      maxBuffer: 64 * 1024,
      windowsHide: true,
      shell: false,
      signal,
    });
    const fields = stdout.trim().split("\t");
    if (fields[0] !== "bigbud-remote-agent" || !fields.slice(7).includes("inspect-local=1"))
      throw new Error("Missing inspection capability.");
  } catch {
    // Never forward binary output or paths; --inspect-local has not been started.
    throw new Error(
      "Native inspection capability incompatible or unavailable; rebuild the bigbud helper.",
    );
  }
}
