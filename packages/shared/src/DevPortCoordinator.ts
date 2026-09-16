import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, mkdir, open, readdir, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export interface DevPortCoordinator {
  directory: string;
  withLock<T>(action: () => Promise<T>, signal?: AbortSignal): Promise<T>;
}

export interface DevPortReservation {
  token: string;
  port: number;
  kind: "web" | "mobile";
  ownerPid: number;
  parentToken?: string;
}

interface Slot {
  token: string;
  ownerPid: number;
  ticket: number | null;
}

const ACQUISITION_TIMEOUT_MS = 30_000;

async function readSlot(directory: string, name: string): Promise<Slot | undefined> {
  const token = name.endsWith(".json") ? name.slice(0, -5) : "";
  const ownerPid = tokenOwner(token);
  if (ownerPid === undefined) throw new Error(`Unknown coordinator slot: ${name}`);
  const filename = path.join(directory, "slots", name);
  const state = await readState(filename);
  if (!state) return undefined;
  assertKeys(state, ["token", "ownerPid", "ticket"]);
  if (
    state.token !== token ||
    state.ownerPid !== ownerPid ||
    (state.ticket !== null &&
      (typeof state.ticket !== "number" ||
        !Number.isSafeInteger(state.ticket) ||
        state.ticket <= 0))
  ) {
    throw new Error(`Invalid coordinator slot: ${name}`);
  }
  if (ownerIsDead(ownerPid)) {
    // This filename is unique to one acquisition, never a replaceable singleton.
    await removeOwnFile(filename);
    return undefined;
  }
  return { token, ownerPid, ticket: state.ticket as number | null };
}

async function withBakeryLock<T>(
  directory: string,
  action: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const deadline = performance.now() + ACQUISITION_TIMEOUT_MS;
  const check = () => {
    signal?.throwIfAborted();
    if (performance.now() >= deadline)
      throw new Error(
        "Development port lock acquisition timed out after 30s; another launcher may still be starting. Retry when it finishes.",
      );
  };
  const pause = async () => {
    check();
    await delay(Math.min(10, Math.max(1, deadline - performance.now())), undefined, { signal });
    check();
  };
  check();
  const token = newToken();
  const filename = path.join(directory, "slots", `${token}.json`);
  const slot: Slot = { token, ownerPid: process.pid, ticket: null };
  try {
    // Choosing MUST be visible before scanning. Atomic publication avoids partial
    // JSON; atomic replacement leaves no gap when choosing becomes a ticket.
    await publishState(directory, filename, slot);
    check();
    let maximum = 0;
    for (const name of await readdir(path.join(directory, "slots"))) {
      check();
      const other = await readSlot(directory, name);
      maximum = Math.max(maximum, other?.ticket ?? 0);
    }
    if (maximum >= Number.MAX_SAFE_INTEGER) throw new Error("Coordinator ticket range exhausted");
    const ticket = maximum + 1;
    await publishState(directory, filename, { ...slot, ticket }, true);
    check();
    for (const name of await readdir(path.join(directory, "slots"))) {
      if (name === `${token}.json`) continue;
      // Wait for choosing to finish, then re-read the ticket. A snapshot from
      // the maximum scan is insufficient when another process is still choosing.
      while (true) {
        check();
        const other = await readSlot(directory, name);
        if (!other) break;
        if (other.ticket === null) {
          await pause();
          continue;
        }
        // Compare the nonce (not the PID) to break equal-ticket ties.
        if (
          other.ticket > ticket ||
          (other.ticket === ticket &&
            other.token.slice(other.token.indexOf("-") + 1) > token.slice(token.indexOf("-") + 1))
        )
          break;
        await pause();
      }
    }
    check();
    // Cancellation only bounds acquisition: never drop mutual exclusion while
    // an action is still running, even if its caller aborts or it takes too long.
    return await action();
  } finally {
    await removeOwnFile(filename);
  }
}

export async function createDevPortCoordinator(
  repoRoot: string,
  storageRoot?: string,
): Promise<DevPortCoordinator> {
  const { uid, username } = userInfo();
  const userKey = createHash("sha256")
    .update(JSON.stringify([uid, username]))
    .digest("hex")
    .slice(0, 32);
  const root = storageRoot ?? path.join(tmpdir(), `bigbud-dev-ports-${userKey}`);
  // Instance offsets must share this scope to coordinate overlapping ranges.
  const scope = createHash("sha256")
    .update(await realpath(repoRoot))
    .digest("hex");
  const directory = path.join(root, scope);
  for (const child of ["slots", "reservations", "staging"]) {
    await mkdir(path.join(directory, child), { recursive: true, mode: 0o700 });
  }
  return { directory, withLock: (action, signal) => withBakeryLock(directory, action, signal) };
}

const TOKEN =
  /^([1-9][0-9]*)-([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/;

function tokenOwner(token: unknown): number | undefined {
  if (typeof token !== "string") return undefined;
  const match = TOKEN.exec(token);
  const pid = Number(match?.[1]);
  return Number.isSafeInteger(pid) && pid > 0 && pid <= 2147483647 ? pid : undefined;
}

function newToken(): string {
  return `${process.pid}-${randomUUID()}`;
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function ownerIsDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    // PID reuse and permission failures retain ownership. Time is never evidence.
    return hasCode(error, "ESRCH");
  }
}

async function removeOwnFile(filename: string): Promise<void> {
  await unlink(filename).catch((error: unknown) => {
    if (!hasCode(error, "ENOENT")) throw error;
  });
}

async function readState(filename: string): Promise<Record<string, unknown> | undefined> {
  const file = await open(
    filename,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  ).catch((error: unknown) => {
    if (hasCode(error, "ENOENT")) return undefined;
    throw error;
  });
  if (!file) return undefined;
  try {
    if (!(await file.stat()).isFile()) throw new Error(`Invalid coordinator file: ${filename}`);
    const buffer = Buffer.alloc(2049);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 2048) throw new Error(`Oversized coordinator state: ${filename}`);
    const state: unknown = JSON.parse(buffer.subarray(0, bytesRead).toString());
    if (typeof state !== "object" || state === null || Array.isArray(state)) {
      throw new Error(`Invalid coordinator state: ${filename}`);
    }
    return state as Record<string, unknown>;
  } finally {
    await file.close();
  }
}

// The staging directory is not a participant namespace. A crashed unpublished
// write cannot block the bakery; only the atomic link makes it a participant.
async function publishState(
  directory: string,
  filename: string,
  state: object,
  replace = false,
): Promise<void> {
  const temporary = path.join(directory, "staging", `${newToken()}.json`);
  try {
    await writeFile(temporary, JSON.stringify(state), { flag: "wx", mode: 0o600 });
    if (replace) await rename(temporary, filename);
    else await link(temporary, filename);
  } finally {
    await removeOwnFile(temporary);
  }
}

function assertKeys(state: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(state).some((key) => !keys.includes(key))) {
    throw new Error("Unknown coordinator state fields");
  }
}

function validPort(port: unknown): port is number {
  return typeof port === "number" && Number.isInteger(port) && port >= 1 && port <= 65535;
}

/** Call under coordinator.withLock. Only confirmed-dead, unique token files are removed. */
export async function readDevPortReservations(
  coordinator: DevPortCoordinator,
): Promise<DevPortReservation[]> {
  const directory = path.join(coordinator.directory, "reservations");
  const reservations: DevPortReservation[] = [];
  for (const name of await readdir(directory)) {
    const token = name.endsWith(".json") ? name.slice(0, -5) : "";
    const ownerPid = tokenOwner(token);
    if (ownerPid === undefined) throw new Error(`Unknown development port reservation: ${name}`);
    const filename = path.join(directory, name);
    const state = await readState(filename);
    if (!state) continue;
    assertKeys(state, ["token", "port", "kind", "ownerPid", "parentToken"]);
    if (
      state.token !== token ||
      state.ownerPid !== ownerPid ||
      !validPort(state.port) ||
      (state.kind !== "web" && state.kind !== "mobile") ||
      ("parentToken" in state &&
        (state.kind !== "web" ||
          tokenOwner(state.parentToken) === undefined ||
          state.parentToken === token))
    )
      throw new Error(`Invalid development port reservation: ${name}`);
    if (ownerIsDead(ownerPid)) {
      await removeOwnFile(filename);
      continue;
    }
    reservations.push({
      token,
      ownerPid,
      port: state.port,
      kind: state.kind,
      ...(typeof state.parentToken === "string" ? { parentToken: state.parentToken } : {}),
    });
  }
  return reservations;
}

/** Call under coordinator.withLock; the returned release is safe outside the lock. */
export async function reserveDevPort(
  coordinator: DevPortCoordinator,
  port: number,
  kind: "web" | "mobile",
  parentToken?: string,
): Promise<{ reservation: DevPortReservation; release: () => Promise<void> }> {
  if (!validPort(port)) throw new Error("Development port must be between 1 and 65535");
  if (kind !== "web" && kind !== "mobile") throw new Error("Invalid development port kind");
  if (parentToken !== undefined && (kind !== "web" || tokenOwner(parentToken) === undefined)) {
    throw new Error("Only web reservations accept a valid parent token");
  }
  const reservations = await readDevPortReservations(coordinator);
  if (parentToken !== undefined) {
    const parent = reservations.find((record) => record.token === parentToken);
    if (
      !parent ||
      parent.kind !== "web" ||
      parent.port !== port ||
      parent.parentToken !== undefined ||
      ownerIsDead(parent.ownerPid)
    ) {
      throw new Error("Development port parent reservation is not live or does not match");
    }
  }
  const conflict = reservations.some((record) => {
    if (record.port !== port) return false;
    if (parentToken === undefined) return true;
    if (record.token === parentToken) return false;
    return (
      record.kind !== "web" || record.parentToken !== parentToken || record.ownerPid !== process.pid
    );
  });
  if (conflict) throw new Error(`Development port ${port} is already reserved`);
  const reservation: DevPortReservation = {
    token: newToken(),
    port,
    kind,
    ownerPid: process.pid,
    ...(parentToken !== undefined ? { parentToken } : {}),
  };
  const filename = path.join(coordinator.directory, "reservations", `${reservation.token}.json`);
  await publishState(coordinator.directory, filename, reservation);
  // Unique immutable filenames make repeated release unable to erase a successor.
  return { reservation, release: () => removeOwnFile(filename) };
}
