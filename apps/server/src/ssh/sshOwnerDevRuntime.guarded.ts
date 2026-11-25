import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DEV_SSH_OWNER_GUARDED_APPROVAL,
  DEV_SSH_OWNER_GUARDED_MARKER,
  isDevSshOwnerProfile,
  supportsDevSshOwnerGuardedFixture,
} from "@bigbud/shared/DevLauncher";
import type * as Effect from "effect/Effect";
import type { initializeDevSshGuardedWriteJournal } from "../persistence/Layers/DevSshGuardedWriteJournal.ts";
import type { SelectedExclusiveWorkspaceCreate } from "../ws/wsSshOwnerDev.workspace.create.ts";
import type { SelectedGuardedWorkspaceWrite } from "../ws/wsSshOwnerDev.workspace.guarded.ts";
import { PickerProofOwnerError, type PickerProofOwner } from "./sshOwnerPickerProof.client.ts";
import type { makeSshOwnerDevPicker } from "./sshOwnerDevPicker.ts";
import { applyGuardedWriteWithJournal } from "./sshOwnerPickerProof.guardedWriteJournal.ts";

type WithOwner = ReturnType<typeof makeSshOwnerDevPicker<PickerProofOwner>>["withOwner"];
type Owner = Parameters<Parameters<WithOwner>[1]>[0];
type Journal = Effect.Success<ReturnType<typeof initializeDevSshGuardedWriteJournal>>;

export async function guardedDevProfileSelected(profile: string): Promise<boolean> {
  if (
    !isDevSshOwnerProfile(profile, process.platform, tmpdir()) ||
    !(await supportsDevSshOwnerGuardedFixture())
  )
    return false;
  try {
    const marker = path.join(profile, DEV_SSH_OWNER_GUARDED_MARKER);
    const [directory, file] = await Promise.all([lstat(profile), lstat(marker)]);
    return (
      directory.isDirectory() &&
      file.isFile() &&
      file.size === DEV_SSH_OWNER_GUARDED_APPROVAL.length &&
      directory.uid === process.getuid?.() &&
      file.uid === directory.uid &&
      (directory.mode & 0o777) === 0o700 &&
      (file.mode & 0o777) === 0o600 &&
      (await readFile(marker, "utf8")) === DEV_SSH_OWNER_GUARDED_APPROVAL
    );
  } catch {
    return false;
  }
}

const sha256 = (body: Uint8Array) => createHash("sha256").update(body).digest("hex");

export function makeGuardedDevWorkspace(options: {
  readonly profileId: string;
  readonly targetId: string;
  readonly cwd: string;
  readonly withOwner: WithOwner;
  readonly journal: Journal;
}) {
  const { profileId, targetId, cwd, withOwner, journal } = options;
  const scope = { profileId, targetId, cwd };
  const qualified = new WeakMap<Owner, Promise<boolean>>();
  const createQualified = new WeakMap<Owner, Promise<boolean>>();

  async function proveCreate(owner: Owner) {
    let dir: string | undefined;
    let settled = false;
    try {
      dir = await mkdtemp(path.join(cwd, ".create-qualification-"));
      const relativePath = `${path.basename(dir)}/probe`;
      const input = { executionTargetId: targetId, workspaceRoot: cwd, relativePath };
      const contents = Buffer.from("exclusive create qualification\n");
      const created = await owner.createProofWorkspaceFile({ ...input, contents });
      const collision = await owner.createProofWorkspaceFile({
        ...input,
        contents: new Uint8Array(),
      });
      settled = true;
      return (
        created === "created" &&
        collision === "alreadyExists" &&
        (await readFile(path.join(dir, "probe"))).equals(contents)
      );
    } catch {
      return false;
    } finally {
      // A lost acknowledgement does not fence the remote command. Leave the
      // unique probe directory to disposable fixture teardown in that case.
      if (settled && dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  const exclusiveCreate: SelectedExclusiveWorkspaceCreate = {
    apply: (input) =>
      withOwner(targetId, async (owner) => {
        if ((await createQualified.get(owner)) !== true) {
          delete workspace.exclusiveCreate;
          return "notQualified";
        }
        try {
          return await owner.createProofWorkspaceFile({
            executionTargetId: targetId,
            workspaceRoot: cwd,
            ...input,
          });
        } catch (error) {
          if (error instanceof PickerProofOwnerError && error.code === "outcomeUnknown") {
            createQualified.set(owner, Promise.resolve(false));
            delete workspace.exclusiveCreate;
          }
          throw error;
        }
      }),
  };

  // Use actual authenticated APPLY as the capability check. This exercises the exact
  // /usr/bin/python3 recipe in this SSH command sandbox, not the launcher's PATH.
  async function prove(owner: Owner) {
    const operationId = randomUUID();
    const relativePath = `.guarded-qualification-${operationId}`;
    const file = path.join(cwd, relativePath);
    const base = Buffer.from("qualification base\n");
    const contents = Buffer.from("qualification saved\n");
    let created = false;
    try {
      await writeFile(file, base, { flag: "wx", mode: 0o600 });
      created = true;
      const result = await applyGuardedWriteWithJournal(journal, owner, {
        ...scope,
        operationId,
        relativePath,
        contents,
        baseSha256: sha256(base),
      });
      return (
        result.kind === "saved" &&
        result.resultSha256 === sha256(contents) &&
        (await readFile(file)).equals(contents)
      );
    } catch {
      return false;
    } finally {
      if (created) await unlink(file).catch(() => undefined);
    }
  }

  function qualify(owner: Owner) {
    const previous = qualified.get(owner);
    if (previous) return previous;
    const proof = prove(owner);
    qualified.set(owner, proof);
    return proof;
  }

  const guardedWrite: SelectedGuardedWorkspaceWrite = {
    apply: (input) =>
      withOwner(targetId, async (owner) => {
        if ((await qualified.get(owner)) !== true) {
          delete workspace.guardedWrite;
          return { kind: "terminal" };
        }
        return applyGuardedWriteWithJournal(journal, owner, { ...scope, ...input });
      }),
  };
  const runGuardedWithOwner: WithOwner = (id, operation, signal) =>
    withOwner(
      id,
      async (owner) => {
        const result = await operation(owner);
        if (!signal?.aborted) {
          const proven = await qualify(owner);
          if (proven && !signal?.aborted) workspace.guardedWrite = guardedWrite;
          else delete workspace.guardedWrite;
          if (proven && !signal?.aborted) {
            let proof = createQualified.get(owner);
            if (!proof) {
              proof = proveCreate(owner);
              createQualified.set(owner, proof);
            }
            if ((await proof) && !signal?.aborted) workspace.exclusiveCreate = exclusiveCreate;
            else delete workspace.exclusiveCreate;
          } else delete workspace.exclusiveCreate;
        }
        return result;
      },
      signal,
    );

  // Register on admission, not after the workspace read: entryActions can race
  // both the first read and its subsequent authenticated proof.
  const pending = new Set<Promise<void>>();
  const guardedWithOwner: WithOwner = (id, operation, signal) => {
    const result = runGuardedWithOwner(id, operation, signal);
    if (id === targetId && !workspace.exclusiveCreate) {
      const settled = result.then(
        () => undefined,
        () => undefined,
      );
      pending.add(settled);
      void settled.then(() => pending.delete(settled));
    }
    return result;
  };

  const workspace: {
    targetId: string;
    workspaceRoot: string;
    withOwner: WithOwner;
    guardedWrite?: SelectedGuardedWorkspaceWrite;
    exclusiveCreate?: SelectedExclusiveWorkspaceCreate;
    pendingCreateQualification: () => Promise<void> | undefined;
  } = {
    targetId,
    workspaceRoot: cwd,
    withOwner: guardedWithOwner,
    pendingCreateQualification: () => pending.values().next().value,
  };
  return workspace;
}
