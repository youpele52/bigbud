import { randomBytes } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import * as fs from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import type { LocalSupervisorControl } from "./localSupervisorControl.ts";
import {
  assertLocalSupervisorServiceDirectory as directory,
  readLocalSupervisorServiceFile,
} from "./localSupervisorService.files.ts";
import {
  LOCAL_SUPERVISOR_BACKEND_TUPLE_KEYS,
  decodeLocalSupervisorAuthority,
  encodeLocalSupervisorAuthority,
  expectedLocalSupervisorAuthority,
  type LocalSupervisorBackendTuple,
  type LocalSupervisorAuthorityIdentity,
} from "./localSupervisorAuthority.record.ts";

const NAME = "account-authority-v1";
const PENDING = /^\.account-authority-[a-f0-9]{32}\.tmp$/;
function assertScope(
  control: LocalSupervisorControl,
  identity: LocalSupervisorAuthorityIdentity,
): void {
  if (
    control.targetId !== `remote-backend:${identity.authority.authorityId}` ||
    !/^[a-f0-9]{32}$/.test(identity.authority.authorityId) ||
    !/^sha256:[a-f0-9]{64}$/.test(identity.installationFingerprint) ||
    control.root !== join(control.homeDir, ".bigbud/agent")
  )
    throw new Error("Account supervisor authority does not match the owning backend installation.");
}
async function backendSnapshot(home: string, state: string): Promise<LocalSupervisorBackendTuple> {
  await directory(home);
  await directory(state);
  const child = relative(home, state);
  if (!child || child === ".." || child.startsWith("../") || isAbsolute(child))
    throw new Error("Backend state must remain beneath its canonical private backend home.");
  const base = await fs.lstat(home, { bigint: true });
  const root = await fs.lstat(state, { bigint: true });
  return {
    backend_home: home,
    backend_home_dev: base.dev.toString(),
    backend_home_ino: base.ino.toString(),
    backend_state: state,
    backend_state_dev: root.dev.toString(),
    backend_state_ino: root.ino.toString(),
  };
}
async function rootSnapshot(control: LocalSupervisorControl): Promise<BigIntStats> {
  await directory(control.homeDir, [0o700, 0o750, 0o755]);
  await directory(join(control.homeDir, ".bigbud"), [0o700, 0o755]);
  await directory(control.root);
  return fs.lstat(control.root, { bigint: true });
}
async function sameRoot(control: LocalSupervisorControl, before: BigIntStats): Promise<void> {
  const after = await rootSnapshot(control);
  if (after.dev !== before.dev || after.ino !== before.ino)
    throw new Error("The account supervisor root changed; preserve ownership for repair.");
}

/** Read/adoption never creates or claims account state, and key/process epochs are not identity. */
async function readAndAssertReservation(
  control: LocalSupervisorControl,
  identity: LocalSupervisorAuthorityIdentity,
) {
  assertScope(control, identity);
  const before = await rootSnapshot(control);
  const actual = decodeLocalSupervisorAuthority(
    await readLocalSupervisorServiceFile(join(control.root, NAME), 16 * 1024),
  );
  const backend = await backendSnapshot(actual.backend_home, actual.backend_state);
  const expected = expectedLocalSupervisorAuthority(control.root, before, identity, backend);
  await sameRoot(control, before);
  if (encodeLocalSupervisorAuthority(actual) !== encodeLocalSupervisorAuthority(expected))
    throw new Error(
      "Account supervisor ownership belongs to another authority, installation or copied root; explicit repair is required.",
    );
  return actual;
}
export async function assertLocalSupervisorAuthorityReservation(
  control: LocalSupervisorControl,
  identity: LocalSupervisorAuthorityIdentity,
): Promise<void> {
  await readAndAssertReservation(control, identity);
}

/** Bind an existing reservation to the actual locked backend state, without claiming anything. */
export async function assertLocalSupervisorBackendReservation(
  control: LocalSupervisorControl,
  identity: LocalSupervisorAuthorityIdentity,
  backendStateDir: string,
): Promise<void> {
  const actual = await readAndAssertReservation(control, identity);
  if (actual.backend_state !== backendStateDir)
    throw new Error("Account supervisor reservation belongs to another backend state.");
}
async function assertClaimReservation(
  control: LocalSupervisorControl,
  identity: LocalSupervisorAuthorityIdentity,
  backend: LocalSupervisorBackendTuple,
): Promise<void> {
  const actual = await readAndAssertReservation(control, identity);
  if (LOCAL_SUPERVISOR_BACKEND_TUPLE_KEYS.some((key) => actual[key] !== backend[key]))
    throw new Error("Claimed backend context differs from the established reservation.");
}

async function createFreshRoot(control: LocalSupervisorControl): Promise<BigIntStats> {
  await directory(control.homeDir, [0o700, 0o750, 0o755]);
  for (const path of [join(control.homeDir, ".bigbud"), control.root]) {
    try {
      await fs.mkdir(path, { mode: 0o700 });
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
    }
    await directory(path, path === control.root ? [0o700] : [0o700, 0o755]);
  }
  return rootSnapshot(control);
}
async function names(root: string): Promise<ReadonlyArray<string>> {
  const result: string[] = [];
  const opened = await fs.opendir(root);
  for await (const entry of opened) {
    result.push(entry.name);
    if (result.length > 32)
      throw new Error("Unclaimed account supervisor state is not a fresh installation.");
  }
  return result;
}
async function awaitConcurrentClaim(
  control: LocalSupervisorControl,
  identity: LocalSupervisorAuthorityIdentity,
  before: BigIntStats,
  backend: LocalSupervisorBackendTuple,
): Promise<void> {
  const deadline = performance.now() + 1000;
  let failure: unknown;
  do {
    await sameRoot(control, before);
    try {
      await assertClaimReservation(control, identity, backend);
      return;
    } catch (cause) {
      failure = cause;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  } while (performance.now() < deadline);
  throw new Error("Concurrent account authority publication did not settle; preserve its files.", {
    cause: failure,
  });
}
async function unlinkOwnedTemporary(path: string, owned: BigIntStats): Promise<void> {
  const named = await fs.lstat(path, { bigint: true });
  if (
    !named.isFile() ||
    named.uid !== owned.uid ||
    named.dev !== owned.dev ||
    named.ino !== owned.ino
  )
    throw new Error("Account authority publication temporary changed; preserve it.");
  await fs.unlink(path);
}

/** Explicit fresh setup only. Existing/legacy unreserved account state is never migrated. */
export async function claimLocalSupervisorAuthorityReservation(
  control: LocalSupervisorControl,
  identity: LocalSupervisorAuthorityIdentity,
  consent: {
    readonly confirmFreshSetup: true;
    readonly backendHome: string;
    readonly backendStateDir: string;
  },
): Promise<void> {
  if (consent.confirmFreshSetup !== true)
    throw new Error("Fresh account supervisor setup requires explicit consent.");
  assertScope(control, identity);
  const backend = await backendSnapshot(consent.backendHome, consent.backendStateDir);
  const before = await createFreshRoot(control);
  try {
    await assertClaimReservation(control, identity, backend);
    return;
  } catch (cause) {
    const existing = await names(control.root);
    // A concurrent publisher may have completed after the first ENOENT but before listing.
    if (existing.includes(NAME)) {
      try {
        await assertClaimReservation(control, identity, backend);
        return;
      } catch (recheck) {
        if (!existing.some((name) => PENDING.test(name)))
          throw new Error("Existing account ownership cannot be replaced or auto-migrated.", {
            cause: recheck,
          });
      }
    }
    if (existing.some((name) => PENDING.test(name))) {
      if (existing.some((name) => name !== NAME && !PENDING.test(name)))
        throw new Error(
          "Unreserved legacy account state must be preserved for explicit migration.",
          { cause },
        );
      return awaitConcurrentClaim(control, identity, before, backend);
    }
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT" || existing.length !== 0)
      throw new Error("Existing or unreadable account ownership cannot be auto-claimed.", {
        cause,
      });
  }
  await sameRoot(control, before);
  const temporary = join(control.root, `.account-authority-${randomBytes(16).toString("hex")}.tmp`);
  const file = await fs.open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  let owned: BigIntStats | undefined;
  let collided = false;
  try {
    owned = await file.stat({ bigint: true });
    if (
      !owned.isFile() ||
      owned.uid !== before.uid ||
      (owned.mode & 0o7777n) !== 0o600n ||
      owned.nlink !== 1n
    )
      throw new Error(
        "Fresh account reservation publication requires an owned private regular file.",
      );
    await file.writeFile(
      encodeLocalSupervisorAuthority(
        expectedLocalSupervisorAuthority(control.root, before, identity, backend),
      ),
    );
    await file.sync();
    await sameRoot(control, before);
    if (
      JSON.stringify(backend) !==
      JSON.stringify(await backendSnapshot(consent.backendHome, consent.backendStateDir))
    )
      throw new Error("Backend root changed during account authority publication.");
    try {
      await fs.link(temporary, join(control.root, NAME));
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
      collided = true;
    }
  } finally {
    await file.close();
    if (owned) await unlinkOwnedTemporary(temporary, owned);
  }
  const root = await fs.open(
    control.root,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await root.sync();
  } finally {
    await root.close();
  }
  if (collided) return awaitConcurrentClaim(control, identity, before, backend);
  await assertClaimReservation(control, identity, backend);
}
