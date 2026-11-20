import { requireServiceSetupCompletion } from "./localSupervisorService.setup.completion.ts";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { ownershipStateDir } from "@bigbud/shared/backendOwnership.paths";
import { assertLocalSupervisorAuthorityReservation } from "./localSupervisorAuthority.ts";
import { verifyManagedLocalSupervisor } from "./localSupervisorBinary.ts";
import { readLocalSupervisorServiceConfig } from "./localSupervisorService.config.read.ts";
import {
  localSupervisorServiceSetupDependencies,
  type LocalSupervisorServiceSetupDependencies,
} from "./localSupervisorService.setup.runtime.ts";
import type { LocalSupervisorPreflightContext } from "./localSupervisorService.preflight.ts";
import { quoteRemoteAgentLaunchValue as quote } from "../remote-agent/remoteAgentRuntime.launch.prepare.ts";
export type LocalSupervisorServiceSetupStatus =
  | { readonly status: "absent" }
  | { readonly status: "needs-repair"; readonly message: string }
  | {
      readonly status: "present";
      readonly authorityId: string;
      readonly configPath: string;
      readonly epoch: string;
      readonly nativeStatus: string;
      readonly backendReadiness: "not-assessed";
    };
/** Observation only: no status/Boolean/serialized receipt substitutes for an original setup proof. */
export function makeLocalSupervisorServiceSetupInspector(
  dependencies: LocalSupervisorServiceSetupDependencies = localSupervisorServiceSetupDependencies,
) {
  return async (
    context: LocalSupervisorPreflightContext,
    signal: AbortSignal,
  ): Promise<LocalSupervisorServiceSetupStatus> => {
    signal.throwIfAborted();
    await context.owner.assertHeld();
    const account = dependencies.account(),
      home = await fs.realpath(account.home),
      authority = context.identity.authority.authorityId;
    const configPath = join(home, ".bigbud/backend-services", authority, "config-v1");
    try {
      await fs.lstat(join(home, ".bigbud/backend-services", authority));
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
      try {
        await fs.lstat(join(home, ".bigbud/agent"));
      } catch (absent) {
        if ((absent as NodeJS.ErrnoException).code === "ENOENT") return { status: "absent" };
        throw absent;
      }
      return {
        status: "needs-repair",
        message:
          "Account state exists without a complete service namespace; inspect it explicitly.",
      };
    }
    try {
      if (
        account.operatingSystem !== "linux" ||
        account.uid === 0 ||
        account.uid !== process.getuid?.()
      )
        throw new Error("Unprivileged Linux account required.");
      await requireServiceSetupCompletion(join(configPath, ".."), context);
      const { config } = await readLocalSupervisorServiceConfig({
        homeDir: home,
        configPath,
        authorityId: authority,
      });
      if (
        config.expected_installation_fingerprint !== context.identity.installationFingerprint ||
        ownershipStateDir(config.backend_home, false) !== context.owner.stateDir
      )
        throw new Error("Service installation does not match the held backend.");
      const control = dependencies.control(home, `remote-backend:${authority}`, signal);
      await assertLocalSupervisorAuthorityReservation(control, context.identity);
      const binding = await context.owners.getBinding(control.targetId);
      if (
        !binding ||
        binding.runtime.binaryPath !== config.rust_binary ||
        binding.runtime.sha256 !== config.rust_sha256 ||
        binding.runtime.statePath !== config.rust_state
      )
        throw new Error("Canonical service runtime binding is missing or different.");
      await verifyManagedLocalSupervisor(binding.runtime);
      signal.throwIfAborted();
      const caps = (
        await control.run(
          control.targetId,
          `${quote(binding.runtime.binaryPath)} --check --capabilities`,
          { timeoutMs: 5000, maxBufferBytes: 4096, signal },
        )
      ).stdout.split(/\s+/);
      if (!caps.includes("backend-service=2") || !caps.includes("backend-service-graph=1"))
        throw new Error("Graph-aware selected artifact required.");
      // render validates every pinned graph member, but never executes Node or writes unit files.
      await control.run(
        control.targetId,
        `${quote(binding.runtime.binaryPath)} --backend-service render ${quote(configPath)}`,
        { timeoutMs: 60000, maxBufferBytes: 64 * 1024, signal },
      );
      const observed = await control.run(
        control.targetId,
        `${quote(binding.runtime.binaryPath)} --backend-service status ${quote(configPath)}`,
        { timeoutMs: 60000, maxBufferBytes: 64 * 1024, signal },
      );
      signal.throwIfAborted();
      await context.owner.assertHeld();
      return {
        status: "present",
        authorityId: authority,
        configPath,
        epoch: binding.expectedEpoch,
        nativeStatus: observed.stdout,
        backendReadiness: "not-assessed",
      };
    } catch {
      signal.throwIfAborted();
      return {
        status: "needs-repair",
        message:
          "Service state could not be verified; preserve its files and inspect it explicitly.",
      };
    }
  };
}
export const inspectLocalSupervisorServiceSetup = makeLocalSupervisorServiceSetupInspector();
