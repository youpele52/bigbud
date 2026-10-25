import { createHash } from "node:crypto";
import path from "node:path";
import { syncV2FamilyDirectory } from "./Subagents.ownership.fs.ts";
import { Schema } from "effect";
import {
  ensureV2ThreadPrivateChild,
  listV2ThreadPrivateDirectory,
  readV2ThreadPrivateFile,
  writeV2ThreadPrivateFile,
} from "./Orchestration.storage.ts";

import { Child, Snapshot, type V2OwnedChild } from "./Subagents.ownership.schema.ts";
export type { V2OwnedChild } from "./Subagents.ownership.schema.ts";

/** Append-only, fsynced ownership snapshots. An interrupted write is uncertainty, never permission to replay. */
export class V2OwnedFamily {
  private queue: Promise<unknown> = Promise.resolve();
  private fenced: boolean;
  private fenceRevision = 0;
  private persistenceFailed = false;
  get persistenceUncertain() {
    return this.persistenceFailed;
  }
  private constructor(
    private readonly directory: string,
    private snapshot: Snapshot,
  ) {
    this.fenced = snapshot.fenced;
  }
  static async open(
    stateDir: string,
    identity: Pick<Snapshot, "storageIdentity" | "rootId" | "threadId">,
  ) {
    const root = await ensureV2ThreadPrivateChild(stateDir, "opencode-v2-native-families");
    const key = createHash("sha256")
      .update(JSON.stringify([identity.storageIdentity, identity.rootId, identity.threadId]))
      .digest("hex");
    const directory = await ensureV2ThreadPrivateChild(root, key);
    if (process.platform !== "win32") {
      await syncV2FamilyDirectory(stateDir);
      await syncV2FamilyDirectory(root);
      await syncV2FamilyDirectory(directory);
    }
    const names = (await listV2ThreadPrivateDirectory(directory)).toSorted();
    if (names.length > 4096 || names.some((name) => !/^\d{10}\.json$/.test(name)))
      throw new Error("V2 family journal inventory rejected.");
    let snapshot: Snapshot = { version: 1, ...identity, revision: 0, fenced: false, children: [] };
    for (const name of names) {
      const next = Schema.decodeUnknownSync(Snapshot)(
        JSON.parse(await readV2ThreadPrivateFile(path.join(directory, name))),
      );
      if (
        next.storageIdentity !== identity.storageIdentity ||
        next.rootId !== identity.rootId ||
        next.threadId !== identity.threadId ||
        next.revision !== snapshot.revision + 1 ||
        Number.parseInt(name) !== next.revision ||
        next.children.length > 128
      )
        throw new Error("V2 family journal lineage/revision rejected.");
      const ids = new Set<string>();
      for (const child of next.children) {
        const parent = next.children.find((entry) => entry.id === child.parentId);
        if (
          ids.has(child.id) ||
          child.id === identity.rootId ||
          (child.parentId !== identity.rootId && (!parent || parent.depth + 1 !== child.depth)) ||
          child.depth < 1 ||
          child.depth > 16 ||
          child.taskId !== V2OwnedFamily.taskId(identity.storageIdentity, identity.rootId, child.id)
        )
          throw new Error("V2 family journal graph rejected.");
        ids.add(child.id);
      }
      snapshot = next;
    }
    return new V2OwnedFamily(directory, snapshot);
  }
  static taskId(storage: string, root: string, child: string) {
    return `bbv2-owned:${createHash("sha256")
      .update(JSON.stringify([storage, root, child]))
      .digest("hex")}`;
  }
  get isFenced() {
    return this.fenced;
  }
  get children(): readonly V2OwnedChild[] {
    return this.snapshot.children;
  }
  get live() {
    return this.pendingSpawnCount > 0 || this.children.some((child) => child.state !== "terminal");
  }
  get pendingSpawnCount() {
    return this.snapshot.pendingSpawns?.length ?? 0;
  }
  /** Durable pre-creation obligation bridges the gap between spawn and child enrollment. */
  reserveSpawn(key: string) {
    return this.serialize(async () => {
      this.assertSpawn();
      const pending = this.snapshot.pendingSpawns ?? [];
      if (pending.includes(key) || pending.length >= 32)
        throw new Error("V2 spawn receipt replay/capacity rejected.");
      await this.persist({
        ...this.snapshot,
        revision: this.snapshot.revision + 1,
        pendingSpawns: [...pending, key],
      });
      this.assertSpawn();
    });
  }
  completeSpawn(key: string) {
    return this.serialize(async () => {
      this.assertSpawn();
      if (!this.snapshot.pendingSpawns?.includes(key))
        throw new Error("V2 child lacks exact pre-creation receipt.");
      await this.persist({
        ...this.snapshot,
        revision: this.snapshot.revision + 1,
        pendingSpawns: this.snapshot.pendingSpawns.filter((entry) => entry !== key),
      });
    });
  }
  assertSpawnReceipt(key: string) {
    this.assertSpawn();
    if (!this.snapshot.pendingSpawns?.includes(key))
      throw new Error("V2 child lacks exact pre-creation receipt.");
  }
  /** Native executor settlement is distinct from child model idle and from synthetic delivery. */
  execution(
    id: string,
    receipt: string,
    status: "started" | "completed" | "running" | "uncertain",
  ) {
    return this.serialize(async () => {
      this.assertSpawn();
      const child = this.child(id);
      if (
        !child ||
        (status !== "started" && (!child.executionPending || child.executionReceipt !== receipt))
      )
        throw new Error("V2 executor receipt changed ownership or was already settled.");
      await this.persist({
        ...this.snapshot,
        revision: this.snapshot.revision + 1,
        children: this.children.map((entry) =>
          entry.id === id
            ? {
                ...entry,
                executionReceipt: receipt,
                ...(status === "started"
                  ? {
                      executionReceipts: [
                        ...new Set([...(entry.executionReceipts ?? []), receipt]),
                      ].slice(-128),
                    }
                  : {}),
                executionPending: status === "started",
                continuationPending: status === "running" || status === "uncertain",
                ...(status === "running" ? { background: true } : {}),
                ...(status === "uncertain" ? { state: "uncertain" as const } : {}),
              }
            : entry,
        ),
      });
    });
  }
  get rootId() {
    return this.snapshot.rootId;
  }
  child(id: string) {
    return this.children.find((child) => child.id === id);
  }
  get generation() {
    return this.snapshot.generation ?? 0;
  }
  get admission() {
    return this.snapshot.admission;
  }
  /** Only immutable journal dispatch may open a stopped generation, never replay or reconnect. */
  authorizeAdmission(id: string, fingerprint: string) {
    const fenceRevision = this.fenceRevision;
    return this.serialize(async () => {
      if (this.persistenceFailed)
        throw new Error("V2 family persistence is unconfirmed; rearming rejected.");
      if (fenceRevision !== this.fenceRevision)
        throw new Error("V2 newer Stop rejected queued rearming.");
      if (this.fenced && this.live) throw new Error("V2 uncertain descendants prevent rearming.");
      if (this.snapshot.admission?.id === id) {
        if (this.snapshot.admission.fingerprint !== fingerprint || this.fenced)
          throw new Error("V2 stale admission cannot rearm a stopped family.");
        return;
      }
      await this.persist({
        ...this.snapshot,
        generation: this.generation + (this.fenced ? 1 : 0),
        fenced: false,
        admission: { id, fingerprint },
        revision: this.snapshot.revision + 1,
      });
      if (fenceRevision !== this.fenceRevision)
        throw new Error("V2 Stop raced durable rearming; input remains unconfirmed.");
      this.fenced = false;
    });
  }
  recordChildAdmission(id: string, admissionId: string, generation: number) {
    return this.serialize(async () => {
      this.assertSpawn(generation);
      const child = this.child(id);
      if (
        !child ||
        (child.generation ?? 0) !== generation ||
        (child.admissionId && child.admissionId !== admissionId)
      )
        throw new Error("V2 child prompt receipt changed generation/identity.");
      if (child.admissionId === admissionId) return;
      await this.persist({
        ...this.snapshot,
        revision: this.snapshot.revision + 1,
        children: this.children.map((entry) =>
          entry.id === id ? { ...entry, admissionId } : entry,
        ),
      });
      this.assertSpawn(generation);
    });
  }
  assertSpawn(generation = this.generation) {
    if (this.fenced || generation !== this.generation)
      throw new Error("V2 family Stop fence rejects new/resumed descendants.");
  }
  /** Native executor entry preflight; enrollment repeats this after awaited creation to close races. */
  assertCapacity(continuationId?: string) {
    this.assertSpawn();
    const previous = continuationId ? this.child(continuationId) : undefined;
    if (previous && (previous.generation ?? 0) !== this.generation)
      throw new Error("V2 retired generation cannot resume a child.");
    if (continuationId && !previous)
      throw new Error("V2 continuation is not enrolled in this family.");
    if (
      (!previous || previous.state === "terminal") &&
      this.children.filter((child) => child.state !== "terminal").length >= 32
    )
      throw new Error("V2 live descendant capacity exceeded before spawn.");
    if (!previous && this.children.length >= 128)
      throw new Error("V2 durable descendant capacity exceeded before spawn.");
  }
  private serialize<T>(run: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(run, run);
    this.queue = pending.catch(() => {});
    return pending;
  }
  private async persist(next: Snapshot) {
    try {
      if (process.platform === "win32")
        throw new Error(
          "V2 durable family directory flush is unqualified on Windows; no child prompt admitted.",
        );
      if (next.revision > 4096) throw new Error("V2 family journal capacity exceeded.");
      const content = JSON.stringify(next);
      if (Buffer.byteLength(content) > 131072)
        throw new Error("V2 family journal byte capacity exceeded before execution.");
      await writeV2ThreadPrivateFile(
        path.join(this.directory, `${String(next.revision).padStart(10, "0")}.json`),
        content,
      );
      await syncV2FamilyDirectory(this.directory);
      this.snapshot = next;
    } catch (error) {
      this.persistenceFailed = true;
      this.fenced = true;
      throw error;
    }
  }
  /** Synchronous fence wins against enrollment already awaiting disk; durable marker precedes cancellation. */
  fence() {
    this.fenced = true;
    this.fenceRevision++;
    const operation = this.serialize(async () => {
      if (!this.snapshot.fenced)
        await this.persist({
          ...this.snapshot,
          fenced: true,
          revision: this.snapshot.revision + 1,
        });
    });
    return operation.catch((error) => {
      this.persistenceFailed = true;
      throw error;
    });
  }
  async enroll(input: Omit<V2OwnedChild, "taskId" | "state" | "depth">) {
    const generation = this.generation;
    this.assertSpawn(generation);
    return this.serialize(async () => {
      this.assertSpawn(generation);
      const parent = input.parentId === this.rootId ? undefined : this.child(input.parentId);
      if (input.parentId !== this.rootId && !parent)
        throw new Error("V2 child parent is not enrolled.");
      const previous = this.child(input.id);
      if (previous && previous.parentId !== input.parentId)
        throw new Error("V2 child ownership changed.");
      this.assertCapacity(previous?.id);
      if ((parent?.depth ?? 0) >= 16)
        throw new Error("V2 durable descendant capacity/depth exceeded before prompt.");
      const child = Schema.decodeUnknownSync(Child)({
        ...input,
        ...(previous
          ? {
              ...(previous.turnId ? { turnId: previous.turnId } : {}),
              messageId: previous.messageId,
              callId: previous.callId,
              ...(previous.executionReceipts
                ? { executionReceipts: previous.executionReceipts }
                : {}),
            }
          : {}),
        taskId: V2OwnedFamily.taskId(this.snapshot.storageIdentity, this.rootId, input.id),
        depth: (parent?.depth ?? 0) + 1,
        state: "enrolled",
        generation,
      });
      await this.persist({
        ...this.snapshot,
        revision: this.snapshot.revision + 1,
        children: [...this.children.filter((entry) => entry.id !== child.id), child],
      });
      this.assertSpawn(generation);
      return child;
    });
  }
  observe(id: string, state: V2OwnedChild["state"], observedRevision?: number) {
    return this.serialize(async () => {
      const child = this.child(id);
      if (!child) throw new Error("V2 unknown descendant observation.");
      if (child.state === state && observedRevision === undefined) return;
      if (child.state === state && observedRevision === child.observedRevision) return;
      await this.persist({
        ...this.snapshot,
        revision: this.snapshot.revision + 1,
        children: this.children.map((entry) =>
          entry.id === id
            ? { ...entry, state, ...(observedRevision === undefined ? {} : { observedRevision }) }
            : entry,
        ),
      });
    });
  }
  nativeCompletion(id: string, inputID: string) {
    return this.serialize(async () => {
      this.assertSpawn();
      if (!this.child(id)) throw new Error("V2 native completion child is not enrolled.");
      if (this.child(id)?.nativeCompletion === inputID) return;
      await this.persist({
        ...this.snapshot,
        revision: this.snapshot.revision + 1,
        children: this.children.map((child) =>
          child.id === id
            ? {
                ...child,
                nativeCompletion: inputID,
                executionPending: false,
                continuationPending: false,
              }
            : child,
        ),
      });
    });
  }
  confirmNativeDrain() {
    return this.serialize(async () => {
      if (this.persistenceFailed || !this.fenced)
        throw new Error("V2 native drain cannot clear journal uncertainty.");
      await this.persist({
        ...this.snapshot,
        revision: this.snapshot.revision + 1,
        pendingSpawns: [],
        children: this.children.map((child) => ({
          ...child,
          state: "terminal" as const,
          executionPending: false,
          continuationPending: false,
        })),
      });
    });
  }
}
