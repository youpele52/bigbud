import fs from "node:fs/promises";
import path from "node:path";

interface SessionFsSequenceState {
  readonly nextSequence: number;
  readonly handlerId?: string;
  readonly recreated?: boolean;
  readonly inFlight?: { readonly sequence: number; readonly operation: string };
  readonly ambiguous?: { readonly sequence: number; readonly operation: string };
}

export interface RemoteSessionFsSequence {
  readonly allocate: (operation: string, mutation: boolean) => Promise<number>;
  readonly complete: (sequence: number) => Promise<void>;
  readonly markAmbiguous: (sequence: number) => Promise<void>;
}

const locks = new Map<string, Promise<void>>();

async function withLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  locks.set(key, tail);
  await previous;
  try {
    return await task();
  } finally {
    release();
    if (locks.get(key) === tail) locks.delete(key);
  }
}

async function readState(filePath: string): Promise<SessionFsSequenceState> {
  try {
    const value = JSON.parse(await fs.readFile(filePath, "utf8")) as SessionFsSequenceState;
    if (!Number.isSafeInteger(value.nextSequence) || value.nextSequence < 1)
      throw new Error("Invalid remote session filesystem sequence state.");
    return value;
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
      return { nextSequence: 1 };
    throw cause;
  }
}

async function writeState(filePath: string, state: SessionFsSequenceState): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporaryPath, JSON.stringify(state), "utf8");
  await fs.rename(temporaryPath, filePath);
}

/** Allocates durable Copilot session-FS identities and fences ambiguous mutations. */
export function createRemoteSessionFsSequence(
  stateRoot: string,
  sessionId: string,
): RemoteSessionFsSequence {
  const handlerId = `${process.pid}:${Date.now()}:${process.hrtime.bigint()}`;
  const filePath = path.join(
    stateRoot,
    "operation-sequences",
    `${Buffer.from(sessionId).toString("base64url")}.json`,
  );
  const update = <T>(task: (state: SessionFsSequenceState) => Promise<T>) =>
    withLock(filePath, async () => {
      let state = await readState(filePath);
      if (state.handlerId !== undefined && state.handlerId !== handlerId) {
        state = { ...state, handlerId, recreated: true };
        await writeState(filePath, state);
      } else if (state.handlerId === undefined) {
        state = { ...state, handlerId };
        await writeState(filePath, state);
      }
      const result = await task(state);
      return result;
    });

  return {
    allocate: (operation, mutation) =>
      update(async (state) => {
        if (mutation && (state.recreated || state.inFlight || state.ambiguous))
          throw new Error(
            "COPILOT_FS_MUTATION_OUTCOME_UNKNOWN: the previous remote filesystem mutation may have been applied; no mutation was replayed.",
          );
        const sequence = state.nextSequence;
        await writeState(filePath, {
          ...state,
          nextSequence: sequence + 1,
          ...(mutation ? { inFlight: { sequence, operation } } : {}),
        });
        return sequence;
      }),
    complete: (sequence) =>
      update(async (state) => {
        if (state.inFlight?.sequence !== sequence) return;
        const { inFlight: _inFlight, ...completed } = state;
        await writeState(filePath, completed);
      }),
    markAmbiguous: (sequence) =>
      update(async (state) => {
        if (state.inFlight?.sequence !== sequence) return;
        const { inFlight, ...withoutInFlight } = state;
        await writeState(filePath, {
          ...withoutInFlight,
          ambiguous: inFlight,
        });
      }),
  };
}
