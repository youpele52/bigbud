import fs from "node:fs/promises";
import { constants } from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const input = await new Promise((resolve) => process.once("message", resolve));
const wait = (name) =>
  new Promise((resolve) => {
    const receive = (message) => {
      if (message === name) {
        process.off("message", receive);
        resolve();
      }
    };
    process.on("message", receive);
  });
const original = { lstat: fs.lstat, unlink: fs.unlink, open: fs.open };
let observations = 0;
fs.lstat = async (...args) => {
  const value = await original.lstat(...args);
  if (input.role === "A" && String(args[0]) === input.filename && ++observations === 2) {
    process.send({ state: "last-inode-observed" });
    await wait("resume");
  }
  return value;
};
fs.open = async (...args) => {
  const handle = await original.open(...args);
  if (
    String(args[0]) === input.filename &&
    typeof args[1] === "number" &&
    args[1] & constants.O_EXCL
  )
    process.send({ state: "writer-entered", role: input.role });
  return handle;
};
fs.unlink = async (...args) => {
  if (input.role === "B" && String(args[0]) === input.filename) {
    process.send({ state: "successor-held" });
    await wait("release");
  }
  return original.unlink(...args);
};
syncBuiltinESMExports();
try {
  const authority = { signal: new AbortController().signal, assertCurrent: () => {} };
  if (input.purpose === "record") {
    const { V2ThreadRecords } = await import("./Orchestration.records.ts");
    const records = await V2ThreadRecords.open(
      input.artifact.root,
      "barrier-record",
      input.artifact.privateKey,
      input.artifact.publicKey,
    );
    await records.replace("owned", undefined, { fixtureOwner: input.role });
  } else if (input.purpose === "default") {
    const { V2ImplementationSelection } =
      await import("./Orchestration.implementation.selection.ts");
    const { V2ThreadImplementationRegistry } = await import("./Orchestration.implementation.ts");
    const selection = await V2ImplementationSelection.open(
      input.artifact,
      new V2ThreadImplementationRegistry(),
    );
    await selection.select("v2", authority);
  } else {
    const { acquireV2PluginPublicationLock } = await import("./PluginSetup.lock.ts");
    const { v2NativePluginDirectory } = await import("./PluginSetup.fs.ts");
    const release = await acquireV2PluginPublicationLock(
      input.directory,
      await v2NativePluginDirectory(input.directory),
      input.root,
      input.artifact,
      authority,
    );
    try {
      await fs.writeFile(
        `${input.directory}/owned-writer-${input.role}`,
        "synthetic fixture only",
        { mode: 0o600 },
      );
    } finally {
      await release();
    }
  }
  process.send({ state: "complete" });
} catch {
  process.send({ state: "blocked" });
} finally {
  process.disconnect();
}
