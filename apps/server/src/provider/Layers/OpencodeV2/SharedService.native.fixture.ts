import { spawn } from "node:child_process";
import { readFile, writeFile, copyFile } from "node:fs/promises";
import path from "node:path";
import { expect } from "vitest";
import { closeOwnedChild, isolatedEnvironment } from "./ServerManager.child.ts";
import { makeV2CodingNativeFixture } from "./Coding.native.fixture.ts";
import { ownV2WindowsFixture } from "./SharedService.windows.fixture.mjs";
import { makeOwnedClient } from "./Client.ts";
import { readV2NativeCatalog } from "./Catalog.native.ts";
import { rememberV2OwnedRetailChild } from "./SharedService.native.child.fixture.ts";
import {
  requireV2NativeIsolation,
  verifyV2NativeFixtureImage,
  v2NativeFixtureEnvironment,
  assertV2NativeFixtureVersion,
} from "./SharedService.native.isolation.fixture.ts";
import {
  readV2SharedRegistration,
  v2SharedRegistrationFile,
} from "./SharedService.registration.ts";

/** Registration is published before HTTP readiness; wait for the disposable provider too. */
async function waitForNativeFixtureCatalog(file: string, workspace: string) {
  const registration = await readV2SharedRegistration(file);
  const client = makeOwnedClient({
    endpoint: registration.endpoint.url,
    password: registration.endpoint.auth!.password,
  });
  await expect
    .poll(
      async () => {
        const catalog = await readV2NativeCatalog(client, workspace, {
          requested: { providerID: "bigbud-v2-fixture", id: "synthetic-model" },
        });
        return catalog.data.some(
          (model) => model.providerID === "bigbud-v2-fixture" && model.id === "synthetic-model",
        );
      },
      { timeout: 15000 },
    )
    .toBe(true);
}

/** Retail qualification requires independently approved clean-machine provenance before any launch. */
export async function sharedServiceNativeFixture(
  binary: string,
  prepareConfig?: (file: string) => Promise<void>,
  databaseName = "opencode.db",
) {
  const approval = await requireV2NativeIsolation(binary);
  const fixture = await makeV2CodingNativeFixture(32000, approval.fixtureRoot);
  await ownV2WindowsFixture(fixture.profile);
  const env = v2NativeFixtureEnvironment(
    approval,
    fixture.profile,
    fixture.workspace,
    await isolatedEnvironment({
      binaryPath: binary,
      profileRoot: fixture.profile,
      runtimeTargetId: "local",
    }),
  );
  const globalConfig = path.join(fixture.profile, "config", "opencode", "opencode.json");
  // Windows native builds do not consistently discover the XDG config override. Use the documented
  // project config in this disposable workspace; production discovers metadata through the API.
  const configFile =
    process.platform === "win32" ? path.join(fixture.workspace, "opencode.json") : globalConfig;
  if (path.basename(databaseName) !== databaseName)
    throw new Error("Fixture database name must be a basename.");
  env.OPENCODE_DB = path.join(fixture.profile, "data", "opencode", databaseName);
  const config = JSON.parse(await readFile(globalConfig, "utf8"));
  config.agents = {
    "qualification-reviewer": {
      description: "Disposable native config agent",
      mode: "primary",
      system: "Synthetic qualification only",
    },
  };
  config.providers["bigbud-v2-fixture"].models["synthetic-model"].variants = [
    { id: "precise", settings: { temperature: 0.1 } },
  ];
  await writeFile(configFile, JSON.stringify(config), { mode: 0o600 });
  await prepareConfig?.(configFile);
  await writeFile(
    path.join(fixture.workspace, ".agents", "skills", "example", "SKILL.md"),
    "---\nname: example\ndescription: Disposable qualification skill\n---\nSynthetic read-only instructions.\n",
  );
  fixture.state.textOnlyDelegated = true;
  try {
    await assertV2NativeFixtureVersion(approval, env, fixture.profile);
  } catch (error) {
    await fixture.close();
    throw error;
  }
  let child = spawn(binary, ["serve", "--service", "--hostname=127.0.0.1", "--port=0"], {
    env: { ...env, OPENCODE_CONFIG_PROJECT_DISABLE: "0" },
    cwd: fixture.profile,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Startup output belongs only to this disposable profile. Never dump registration/auth bytes.
  let output = Buffer.alloc(0);
  const capture = (chunk: Buffer) => {
    if (output.length < 8192)
      output = Buffer.concat([output, chunk.subarray(0, 8192 - output.length)]);
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  let spawnError: string | undefined;
  child.on("error", (error: NodeJS.ErrnoException) => {
    spawnError = error.code ?? error.name;
  });
  const file = v2SharedRegistrationFile(env);
  let registrationError = "not inspected";
  try {
    await expect
      .poll(
        async () => {
          if (spawnError || child.exitCode !== null || child.signalCode !== null)
            throw new Error("Disposable shared service exited.");
          await ownV2WindowsFixture(fixture.profile);
          return await readV2SharedRegistration(file).then(
            () => true,
            (error: unknown) => {
              registrationError = error instanceof Error ? error.message : "invalid registration";
              return false;
            },
          );
        },
        { timeout: 15000 },
      )
      .toBe(true);
    const registration = await readV2SharedRegistration(file);
    const info = await makeOwnedClient({
      endpoint: registration.endpoint.url,
      password: registration.endpoint.auth!.password,
    }).server.info();
    if (
      registration.version !== approval.nativeVersion ||
      info.version !== approval.nativeVersion ||
      info.pid !== child.pid
    )
      throw new Error(
        "V2 retail image/registration/health identity mismatch; no qualification pass.",
      );
    await verifyV2NativeFixtureImage(approval);
    // A nonempty built-in catalog is not proof that the disposable provider/config has settled.
    await waitForNativeFixtureCatalog(file, fixture.workspace);
    await ownV2WindowsFixture(fixture.profile);
    await rememberV2OwnedRetailChild(child, approval, file, path.dirname(configFile));
    return {
      ...fixture,
      file,
      approval,
      get child() {
        return child;
      },
      configFile,
      async restart(copyHistory: boolean | "empty" = false) {
        await requireV2NativeIsolation(binary, approval.id);
        // Only this fixture-owned process/profile; never use native service lifecycle discovery.
        await closeOwnedChild(child);
        if (child.exitCode === null && child.signalCode === null)
          throw new Error("Disposable fixture exit unconfirmed; refusing history copy.");
        if (copyHistory === true) {
          const original = env.OPENCODE_DB!;
          const copied = path.join(fixture.profile, "data", "opencode", "logical-copy.db");
          await copyFile(original, copied);
          try {
            await copyFile(`${original}-wal`, `${copied}-wal`);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          env.OPENCODE_DB = copied;
        }
        if (copyHistory === "empty")
          env.OPENCODE_DB = path.join(
            fixture.profile,
            "data",
            "opencode",
            "different-empty-history.db",
          );
        child = spawn(binary, ["serve", "--service", "--hostname=127.0.0.1", "--port=0"], {
          env: { ...env, OPENCODE_CONFIG_PROJECT_DISABLE: "0" },
          cwd: fixture.profile,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
        });
        child.stdout.on("data", capture);
        child.stderr.on("data", capture);
        child.on("error", () => {});
        await expect
          .poll(
            async () => {
              await ownV2WindowsFixture(fixture.profile);
              return (await readV2SharedRegistration(file)).pid;
            },
            { timeout: 15000 },
          )
          .toBe(child.pid);
        await waitForNativeFixtureCatalog(file, fixture.workspace);
        await rememberV2OwnedRetailChild(child, approval, file, path.dirname(configFile));
      },
      async close() {
        await closeOwnedChild(child);
        try {
          await verifyV2NativeFixtureImage(approval);
        } finally {
          await fixture.close();
        }
      },
    };
  } catch (error) {
    const diagnostics = JSON.stringify({
      pid: child.pid,
      exitCode: child.exitCode,
      signalCode: child.signalCode,
      spawnError,
      registrationError,
      output: output
        .toString("utf8")
        .split("\n")
        .filter((line) => !/password|authorization|api.?key|token|secret|credential/i.test(line))
        .join("\n")
        .replace(/https?:\/\/[^\s/]*@/g, "http://[redacted]@"),
    });
    await closeOwnedChild(child);
    await fixture.close();
    throw new Error(`Disposable shared service registration failed: ${diagnostics}`, {
      cause: error,
    });
  }
}
