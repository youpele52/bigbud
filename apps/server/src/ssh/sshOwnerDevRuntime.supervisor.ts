import { randomBytes } from "node:crypto";
import {
  constants,
  access,
  link,
  lstat,
  mkdir,
  open,
  realpath,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import { installDevSshOwnerSandbox } from "./sshOwnerDevPicker.sandbox.ts";
import {
  retainedHandoff,
  retainedProfileBinding,
  retainedProfileSelected,
  retainedTargetId,
} from "./sshOwnerDevRuntime.retained.ts";
import {
  startPickerProofOwner,
  type LaunchedPickerProofOwner,
} from "./sshOwnerPickerProof.client.ts";
import { makeLoopbackPickerFixture } from "./sshPicker.loopback.fixture.ts";

export async function superviseRetainedDevOwner(
  profile: string,
  binary: string,
  stopping: AbortSignal,
  ready: () => void,
) {
  if (!(await retainedProfileSelected(profile)) || !path.isAbsolute(binary))
    throw new Error("Expected the isolated macOS Bun development fixture.");
  const root = await realpath(profile);
  const handoff = retainedHandoff(root);
  // One supervisor per fresh profile, even after a failed or partial startup. Never replace.
  await mkdir(path.dirname(handoff), { mode: 0o700 });
  const fixture = await makeLoopbackPickerFixture({ allowInteractiveShell: true });
  let owner: LaunchedPickerProofOwner | undefined;
  try {
    stopping.throwIfAborted();
    const socketPath = path.join(fixture.root, "owner.sock");
    const source = await realpath(binary);
    await access(source, constants.X_OK);
    const wrapper = await installDevSshOwnerSandbox({
      root: fixture.root,
      source,
      existingClientPolicy: fixture.clientSandboxPolicy,
      attachmentSocket: socketPath,
      allowPty: true,
    });
    await fixture.start();
    const capability = randomBytes(32);
    const profileBinding = retainedProfileBinding(root, fixture.root, fixture.port);
    const stateDir = path.join(root, "dev");
    await mkdir(stateDir, { mode: 0o700, recursive: true });
    const state = await lstat(stateDir);
    if (!state.isDirectory() || state.uid !== process.getuid?.() || (state.mode & 0o777) !== 0o700)
      throw new Error("Expected private disposable state.");
    const dbPath = path.join(stateDir, "state.sqlite");
    // Refuse any existing database, including symlink/hardlink destinations.
    await (await open(dbPath, "wx", 0o600)).close();
    // Bootstrap before either backend exists; never hold a second SQLite writer session.
    const ownerEpoch = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* Effect.promise(async () => {
          owner = await startPickerProofOwner({
            binary: wrapper,
            profileBinding,
            targetId: retainedTargetId,
            lockFile: path.join(fixture.root, "owner.lock"),
            sshBinary: fixture.ssh,
            keyscanBinary: "/usr/bin/ssh-keyscan",
            host: fixture.loopback,
            port: fixture.port,
            user: fixture.user,
            identityFile: fixture.identity,
            knownHostsFile: fixture.knownHosts,
            workspaceRoot: fixture.folder,
            devInteractiveTerminal: true,
            attachment: { socketPath, capability },
            sql,
          });
          await owner.detach();
          return Buffer.from(owner.ownerEpoch).toString("hex");
        });
      }).pipe(
        Effect.provide(
          makeSqlitePersistenceLive(dbPath, { worker: false }).pipe(
            Layer.provide(Layer.mergeAll(NodeServices.layer, Logger.layer([]))),
          ),
        ),
      ),
    );
    stopping.throwIfAborted();
    const pending = `${handoff}.pending`;
    await writeFile(
      pending,
      JSON.stringify({
        root: fixture.root,
        port: fixture.port,
        capability: capability.toString("hex"),
        ownerEpoch,
      }),
      { flag: "wx", mode: 0o600 },
    );
    await link(pending, handoff);
    await unlink(pending);
    await new Promise<void>((resolve) => {
      if (stopping.aborted) return resolve();
      stopping.addEventListener("abort", () => resolve(), { once: true });
      ready();
    });
  } finally {
    try {
      await owner?.retireSupervised();
    } finally {
      try {
        await fixture.dispose();
      } finally {
        await Promise.all([handoff, `${handoff}.pending`].map((file) => rm(file, { force: true })));
      }
    }
  }
}

if (import.meta.main) {
  const stopping = new AbortController();
  const stop = () => stopping.abort();
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  process.stdin.once("end", stop);
  process.stdin.once("error", stop);
  process.stdin.resume();
  try {
    await superviseRetainedDevOwner(
      process.env.BIGBUD_SSH_OWNER_NORMAL_DEV_PROFILE ?? "",
      process.env.BIGBUD_SSH_OWNER_BIN ?? "",
      stopping.signal,
      () => process.stdout.write("ready\n"),
    );
  } catch {
    process.stderr.write(
      "The supervised disposable SSH owner could not start or retire cleanly.\n",
    );
    process.exitCode = 1;
  } finally {
    process.stdin.destroy();
  }
}
