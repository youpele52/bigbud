import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect } from "vitest";
import { closeOwnedChild, isolatedEnvironment } from "./ServerManager.child.ts";
import { makeV2CodingNativeFixture } from "./Coding.native.fixture.ts";
import { ownV2WindowsFixture } from "./SharedService.windows.fixture.mjs";
import {
  readV2SharedRegistration,
  v2SharedRegistrationFile,
} from "./SharedService.registration.ts";

/** Real registered service in disposable HOME/XDG/DB only, never an installed TUI service. */
export async function sharedServiceNativeFixture(
  binary: string,
  prepareConfig?: (file: string) => Promise<void>,
  databaseName = "opencode.db",
) {
  const fixture = await makeV2CodingNativeFixture();
  await ownV2WindowsFixture(fixture.profile);
  const env = await isolatedEnvironment({
    binaryPath: binary,
    profileRoot: fixture.profile,
    runtimeTargetId: "local",
  });
  const configFile = path.join(fixture.profile, "config", "opencode", "opencode.json");
  if (path.basename(databaseName) !== databaseName)
    throw new Error("Fixture database name must be a basename.");
  env.OPENCODE_DB = path.join(fixture.profile, "data", "opencode", databaseName);
  const config = JSON.parse(await readFile(configFile, "utf8"));
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
    return {
      ...fixture,
      file,
      get child() {
        return child;
      },
      configFile,
      async restart() {
        // Only this fixture-owned process/profile; never use native service lifecycle discovery.
        await closeOwnedChild(child);
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
      },
      async close() {
        await closeOwnedChild(child);
        await fixture.close();
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
