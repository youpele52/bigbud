import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { createDevPortCoordinator, reserveDevPort } from "@bigbud/shared/DevPortCoordinator";
import { createMobileDevRegistry } from "@bigbud/shared/DevMobileRegistry";
import { afterEach, expect, it, vi } from "vitest";

const execute = promisify(execFile);
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const cleanup: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const directory of cleanup.splice(0).toReversed())
    await rm(directory, { recursive: true, force: true });
});

it.each(["primary", "precedence", "vite"])(
  "preserves reservation and discovery namespaces through real Turbo strict filtering (%s)",
  async (scenario) => {
    const root = await mkdtemp(path.join(tmpdir(), "bigbud-turbo-env-test-"));
    cleanup.push(root);
    const taskRoot = path.join(root, "apps", "fixture");
    const temporary = path.join(root, "custom temporary directory");
    await mkdir(taskRoot, { recursive: true });
    await mkdir(temporary);
    // POSIX uses TMPDIR > TMP > TEMP; Windows uses TEMP > TMP. Preserve all
    // three, rather than making a platform-specific assumption about the winner.
    const tempValues: Array<string | undefined> =
      scenario !== "precedence"
        ? [temporary, undefined, process.platform === "win32" ? temporary : undefined]
        : [temporary, path.join(root, "tmp-fallback"), path.join(root, "temp-fallback")];
    for (const [index, variable] of ["TMPDIR", "TMP", "TEMP"].entries()) {
      const value = tempValues[index];
      if (value !== undefined) await mkdir(value, { recursive: true });
      vi.stubEnv(variable, value);
    }
    const selectedTemporary = tmpdir();
    const configuration = JSON.parse(await readFile(path.join(repoRoot, "turbo.json"), "utf8"));
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({
        name: "bigbud-turbo-env-fixture",
        private: true,
        packageManager: "bun@1.3.14",
        workspaces: ["apps/*"],
      }),
    );
    await writeFile(
      path.join(root, "bun.lock"),
      JSON.stringify({
        lockfileVersion: 1,
        configVersion: 1,
        workspaces: {
          "": { name: "bigbud-turbo-env-fixture" },
          "apps/fixture": { name: "@fixture/probe" },
        },
        packages: {},
      }),
    );
    await writeFile(
      path.join(root, "turbo.json"),
      JSON.stringify({
        globalEnv: configuration.globalEnv,
        ...(configuration.globalPassThroughEnv
          ? { globalPassThroughEnv: configuration.globalPassThroughEnv }
          : {}),
        tasks: { probe: { cache: false } },
      }),
    );
    await writeFile(
      path.join(taskRoot, "package.json"),
      JSON.stringify({
        name: "@fixture/probe",
        scripts: { probe: "node probe.mjs" },
      }),
    );
    const coordinatorUrl = new URL("../packages/shared/src/DevPortCoordinator.ts", import.meta.url)
      .href;
    const registryUrl = new URL("../packages/shared/src/DevMobileRegistry.ts", import.meta.url)
      .href;
    const webPortsUrl = new URL("../apps/web/dev.ports.ts", import.meta.url).href;
    const output = path.join(root, "observed.json");
    const listenerOutput = path.join(root, "listener.json");
    let port = 5734;
    if (scenario === "vite") {
      const socket = createServer();
      await new Promise<void>((resolve, reject) => {
        socket.once("error", reject);
        socket.listen(0, "127.0.0.1", resolve);
      });
      const address = socket.address();
      if (!address || typeof address === "string") throw new Error("Expected TCP address");
      port = address.port;
      await new Promise<void>((resolve, reject) =>
        socket.close((error) => (error ? reject(error) : resolve())),
      );
      // Execute the actual launcher in a temporary checkout, so its canonical
      // identity never touches the live workspace's coordination files.
      for (const name of ["dev.ts", "dev.options.ts", "dev.ports.ts"]) {
        await copyFile(path.join(repoRoot, "apps/web", name), path.join(taskRoot, name));
      }
      await symlink(
        path.join(repoRoot, "apps/web/node_modules"),
        path.join(taskRoot, "node_modules"),
        "junction",
      );
      await writeFile(
        path.join(taskRoot, "vite.config.mjs"),
        `
      import { writeFile } from 'node:fs/promises';
      import { tmpdir } from 'node:os';
      export default {
        server: { host: '127.0.0.1', hmr: false, watch: null },
        optimizeDeps: { noDiscovery: true },
        plugins: [{ name: 'bounded-listener-fixture', configureServer(server) {
          server.httpServer.once('listening', () => {
            setTimeout(async () => {
              await writeFile(${JSON.stringify(listenerOutput)}, JSON.stringify({
                port: server.httpServer.address().port, temporary: tmpdir(),
              }));
              await server.close();
              process.exit(0);
            }, 50);
          });
        } }],
      };
    `,
      );
    }
    await writeFile(
      path.join(taskRoot, "probe.mjs"),
      `
    import { writeFile } from 'node:fs/promises';
    import { tmpdir } from 'node:os';
    import { createDevPortCoordinator } from ${JSON.stringify(coordinatorUrl)};
    import { createMobileDevRegistry } from ${JSON.stringify(registryUrl)};
    import { reserveWebDevPort } from ${JSON.stringify(webPortsUrl)};
    const coordinator = await createDevPortCoordinator(process.env.BIGBUD_DEV_REPO_ROOT);
    const registry = await createMobileDevRegistry(process.env.BIGBUD_DEV_REPO_ROOT);
    await writeFile(${JSON.stringify(output)}, JSON.stringify({
      temporary: tmpdir(), coordinator: coordinator.directory, registry: registry.directory,
      tempEnv: [process.env.TMPDIR, process.env.TMP, process.env.TEMP],
    }));
    ${
      scenario === "vite"
        ? `
      const { runWebDev } = await import('./dev.ts');
      await runWebDev(['--config', 'vite.config.mjs', '--configLoader', 'native']);
    `
        : `
      const lease = await reserveWebDevPort(coordinator, Number(process.env.PORT), process.env.BIGBUD_DEV_WEB_RESERVATION);
      await lease.release();
    `
    }
  `,
    );
    const coordinator = await createDevPortCoordinator(root);
    const registry = await createMobileDevRegistry(root, "7");
    const parent = await coordinator.withLock(() => reserveDevPort(coordinator, port, "web"));
    try {
      const result = await execute(
        process.execPath,
        [path.join(repoRoot, "node_modules/turbo/bin/turbo"), "run", "probe", "--env-mode=strict"],
        {
          cwd: root,
          timeout: 20_000,
          env: {
            ...process.env,
            BIGBUD_DEV_REPO_ROOT: root,
            BIGBUD_DEV_INSTANCE_OFFSET: "7",
            PORT: String(port),
            BIGBUD_DEV_WEB_RESERVATION: parent.reservation.token,
          },
        },
      ).then(
        () => ({ error: "" }),
        (error: { stdout?: string; stderr?: string }) => ({
          error: `${error.stdout ?? ""}\n${error.stderr ?? ""}`,
        }),
      );
      const observed = JSON.parse(await readFile(output, "utf8"));
      // The fixture can create a different namespace before the regression is
      // fixed. It is scoped only to this unique temporary checkout, not live data.
      if (observed.coordinator !== coordinator.directory) cleanup.push(observed.coordinator);
      expect(result.error, JSON.stringify(observed)).toBe("");
      expect(observed).toEqual({
        temporary: selectedTemporary,
        coordinator: coordinator.directory,
        registry: registry.directory,
        tempEnv: tempValues.map((value) => value ?? null),
      });
      if (scenario === "vite") {
        expect(JSON.parse(await readFile(listenerOutput, "utf8"))).toEqual({
          port,
          temporary: selectedTemporary,
        });
      }
    } finally {
      await parent.release();
    }
  },
  30_000,
);
