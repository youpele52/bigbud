import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ensurePrivateRemoteStateRoot } from "./authority.files.ts";
import { RemoteBackendAuthorityError } from "./authority.record.ts";
import {
  assertLocalSupervisorServiceDirectory,
  readLocalSupervisorServiceFile,
} from "./localSupervisorService.files.ts";
import {
  describePrivatePermission,
  labelPrivatePermission,
  PrivatePermissionError,
} from "./privatePermission.ts";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function privateDirectory() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "bigbud-private-permission-")));
  await chmod(directory, 0o700);
  directories.push(directory);
  return directory;
}
const refusal = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error("expected a refusal");
    },
    (cause: unknown) => cause,
  );

it("keeps refusing a non-private backend home and names it with chmod 700", async () => {
  const home = join(await privateDirectory(), "backend");
  await mkdir(home, { mode: 0o700 });
  await chmod(home, 0o755);
  const error = await refusal(
    labelPrivatePermission("backend home directory (--backend-home)", () =>
      assertLocalSupervisorServiceDirectory(home),
    ),
  );
  expect(error).toBeInstanceOf(PrivatePermissionError);
  expect((error as Error).message).toContain("safely permissioned");
  expect(describePrivatePermission((error as PrivatePermissionError).detail)).toBe(
    `The backend home directory (--backend-home) '${home}' has mode 0755; it must be 0700 ` +
      `(private to this account). Run: chmod 700 '${home}'`,
  );
  await chmod(home, 0o700);
  await expect(assertLocalSupervisorServiceDirectory(home)).resolves.toBeUndefined();
});

it("suggests the closest accepted mode for a group-writable account home", async () => {
  const home = join(await privateDirectory(), "account");
  await mkdir(home, { mode: 0o700 });
  await chmod(home, 0o775);
  const error = (await refusal(
    labelPrivatePermission("account home directory", () =>
      assertLocalSupervisorServiceDirectory(home, [0o700, 0o750, 0o755]),
    ),
  )) as PrivatePermissionError;
  const reason = describePrivatePermission(error.detail);
  expect(reason).toContain("has mode 0775; it must be 0700 or 0750 or 0755");
  expect(reason).toContain("(not writable by other users)");
  expect(reason).toContain(`Run: chmod 755 '${home}'`);
});

it("refuses a non-private state directory with the path in its cause", async () => {
  const state = join(await privateDirectory(), "state");
  await mkdir(state, { mode: 0o700 });
  await chmod(state, 0o750);
  const error = await refusal(ensurePrivateRemoteStateRoot(state));
  expect(error).toBeInstanceOf(RemoteBackendAuthorityError);
  const cause = (error as Error).cause as PrivatePermissionError;
  expect(cause).toBeInstanceOf(PrivatePermissionError);
  expect(describePrivatePermission(cause.detail)).toContain(
    `backend state directory '${state}' has mode 0750; it must be 0700`,
  );
});

it("keeps non-permission refusals generic", async () => {
  const directory = await privateDirectory();
  const empty = join(directory, "empty.json");
  await writeFile(empty, "", { mode: 0o600 });
  const error = await refusal(readLocalSupervisorServiceFile(empty, 1024));
  expect(error).not.toBeInstanceOf(PrivatePermissionError);
  expect((error as Error).message).toContain("bounded private owned");
});

it("explains a foreign owner and never echoes an unsafe path", () => {
  const detail = {
    kind: "file" as const,
    path: "/home/a/trust.json",
    allowedModes: [0o600],
    actualMode: 0o600,
    ownedByAccount: false,
    role: "trusted-keys file (--trusted-keys)",
  };
  expect(describePrivatePermission(detail)).toBe(
    "The trusted-keys file (--trusted-keys) '/home/a/trust.json' is not owned by this account; " +
      "it must be owned by this account with mode 0600. Recreate it as this account, or run: " +
      `chown "$(id -u)" '/home/a/trust.json'`,
  );
  const unsafe = { ...detail, path: "/home/a/x\nrm -rf", ownedByAccount: true, actualMode: 0o644 };
  const reason = describePrivatePermission(unsafe);
  expect(reason).not.toContain("rm -rf");
  expect(reason).toContain("Run chmod 600 on it.");
  const quoted = describePrivatePermission({ ...unsafe, path: "/home/a/it's.json" });
  expect(quoted).toContain(`chmod 600 '/home/a/it'\\''s.json'`);
});
