import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { fields, requireKind } from "../system-monitor/wire.reader";

export function decodeProcessIdentity(bytes: Uint8Array) {
  if (bytes.length > 16384) throw new Error("owner_unverified");
  let version = 0,
    pid = 0,
    executable = "",
    sameUser = false;
  const arguments_: string[] = [];
  const seen = new Set<number>();
  fields(bytes, (field, kind, reader) => {
    if (field !== 4 && seen.has(field)) throw new Error("owner_unverified");
    seen.add(field);
    if (field === 1 || field === 2 || field === 5) {
      requireKind(kind, 0);
      const value = reader.uint();
      if (field === 1) version = value;
      if (field === 2) pid = value;
      if (field === 5) sameUser = value === 1;
    } else if (field === 3 || field === 4) {
      requireKind(kind, 2);
      const value = reader.string();
      if (value.length > 4096) throw new Error("owner_unverified");
      if (field === 3) executable = value;
      else arguments_.push(value);
    } else throw new Error("owner_unverified");
  });
  if (version !== 1 || pid <= 0 || !sameUser || !executable || arguments_.length > 32)
    throw new Error("owner_unverified");
  return { pid, executable, arguments: arguments_ };
}

/** OS-derived executable plus exact same-installation desktop launch form, never process name. */
export async function verifyBackendExecutable(input: {
  binary: string;
  pid: number;
  launcher: string;
  entry: string;
}): Promise<void> {
  const bytes = await new Promise<Buffer>((resolve, reject) => {
    execFile(
      input.binary,
      ["--inspect-process", String(input.pid)],
      { encoding: "buffer", timeout: 3000, maxBuffer: 16384, windowsHide: true },
      (error, stdout) => {
        if (error) reject(new Error("owner_unverified"));
        else resolve(stdout);
      },
    );
  });
  const identity = decodeProcessIdentity(bytes);
  const args = identity.arguments;
  if (
    identity.pid !== input.pid ||
    args.length !== 4 ||
    args[2] !== "--bootstrap-fd" ||
    args[3] !== "3" ||
    (await realpath(identity.executable)) !== (await realpath(input.launcher)) ||
    (await realpath(args[1]!)) !== (await realpath(input.entry))
  )
    throw new Error("owner_unverified");
}
