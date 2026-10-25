import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const execute = promisify(execFile);

/** Read-only process observation: a zombie cannot execute or keep writing the fixture. */
export async function fixtureProcessRunning(pid: number) {
  if (process.platform === "win32") {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
      throw error;
    }
  }
  try {
    const { stdout } = await execute("ps", ["-o", "stat=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 1000,
      maxBuffer: 4096,
    });
    return stdout.trim() !== "" && !/^[ZX]/.test(stdout.trim());
  } catch (error) {
    if ((error as { code?: number }).code === 1) return false;
    throw error;
  }
}

/** A real sync build parent and persistent Node descendant, with a file-scoped recovery lease. */
export async function createCheckpointTreeFixture(
  overflow: boolean,
  leaderExits = false,
  options: { startupBudgetMs?: number; publishReadiness?: boolean; nestedCompiler?: boolean } = {},
) {
  const directory = await mkdtemp(
    path.join(process.env.BIGBUD_CHECKPOINT_TEST_TMPDIR ?? tmpdir(), "bigbud-node-tree-"),
  );
  const names = [
    "parent.test.mjs",
    "descendant.mjs",
    "ready.json",
    "heartbeat",
    "go",
    "stop",
    "stopped",
  ];
  const file = path.join(directory, names[0]!);
  await writeFile(
    path.join(directory, "descendant.mjs"),
    `
    import { execFileSync } from 'node:child_process';
    import { existsSync, writeFileSync } from 'node:fs';
    import path from 'node:path';
    const directory = process.argv[2];
    let counter = 0;
    const beat = () => writeFileSync(path.join(directory, 'heartbeat'), String(++counter));
    beat();
    const group = process.platform === 'win32' ? null : Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8', timeout: 1000 }).trim());
    if (${options.publishReadiness !== false}) writeFileSync(path.join(directory, 'ready.json'), JSON.stringify({ root: Number(process.argv[3]), descendant: process.pid, group }));
    process.stdout.on('error', () => {});
    let triggered = false;
    const interval = setInterval(() => {
      if (existsSync(path.join(directory, 'stop'))) {
        clearInterval(interval);
        writeFileSync(path.join(directory, 'stopped'), 'stopped');
        process.exit(0);
      }
      let work = 1;
      for (let index = 0; index < 10000; index++) work = (work * 33 + index) >>> 0;
      beat();
      if (${overflow} && !triggered && existsSync(path.join(directory, 'go'))) {
        triggered = true;
        process.stdout.write('x'.repeat(16384));
      }
    }, 25);
    setTimeout(() => { clearInterval(interval); process.exit(0); }, 30000).unref();
  `,
  );
  await writeFile(
    file,
    `
    import { execFileSync, spawn } from 'node:child_process';
    import { test } from 'node:test';
    import { executeOwnedNode } from ${JSON.stringify(new URL("./checkpoint-node-tests.process.ts", import.meta.url).href)};
    test('owned build with persistent descendant', async () => {
      const args = [${JSON.stringify(path.join(directory, "descendant.mjs"))}, ${JSON.stringify(directory)}, String(process.pid)];
      if (${options.nestedCompiler === true}) await executeOwnedNode(args, { command: process.execPath, cwd: ${JSON.stringify(directory)}, timeoutMs: 20000, maxBuffer: 4096, inheritOwnerGroup: true });
      else if (${leaderExits}) spawn(process.execPath, args, { stdio: 'inherit' }).unref();
      else execFileSync(process.execPath, args, { stdio: 'inherit' });
    });
  `,
  );
  let identity: { root: number; descendant: number; group: number | null } | undefined;
  const startupDeadline = performance.now() + (options.startupBudgetMs ?? 15000);
  const ready = async () => {
    while (performance.now() < startupDeadline) {
      try {
        identity = JSON.parse(await readFile(path.join(directory, "ready.json"), "utf8"));
        return identity!;
      } catch {
        await delay(25);
      }
    }
    throw new Error("Synthetic descendant did not publish readiness within its startup budget");
  };
  return {
    file,
    directory,
    ready,
    trigger: () => writeFile(path.join(directory, "go"), "go"),
    waitForRootExit: async () => {
      const known = await ready();
      while (await fixtureProcessRunning(known.root)) {
        if (performance.now() >= startupDeadline)
          throw new Error("Fixture root did not exit in startup budget");
        await delay(25);
      }
    },
    heartbeat: () => readFile(path.join(directory, "heartbeat"), "utf8"),
    dispose: async (treeJoined = false) => {
      // Recovery never signals a PID: the fixture itself honors this private stop file.
      await writeFile(path.join(directory, "stop"), "stop");
      // Never wait for readiness again or mask its failure with a second startup timeout.
      if (!identity && !treeJoined)
        throw new Error(`Synthetic fixture cleanup unknown: ${directory}`);
      if (identity) {
        const deadline = performance.now() + 5000;
        while (
          (await fixtureProcessRunning(identity.descendant)) ||
          (await fixtureProcessRunning(identity.root))
        ) {
          if (performance.now() >= deadline)
            throw new Error(`Synthetic fixture cleanup unknown: ${directory}`);
          await delay(25);
        }
      }
      for (const name of names) await rm(path.join(directory, name), { force: true });
      await rmdir(directory);
    },
  };
}
