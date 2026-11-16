import { timingSafeEqual } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { resolveServerConfig, type CliServerFlags } from "../cli/cli.config.ts";
import { makeLocalSupervisorControl } from "./localSupervisorControl.ts";
import { localSupervisorTarget } from "./localSupervisorIdentity.ts";
import { makeLocalSupervisorBootReconciler } from "./localSupervisorService.boot.ts";
import { readLocalSupervisorServiceConfig } from "./localSupervisorService.config.read.ts";
import { readLocalSupervisorServiceFile } from "./localSupervisorService.files.ts";
import { runLocalSupervisorServicePreflight } from "./localSupervisorService.preflight.ts";
import { bindAccountServiceIdentity } from "./identity.service.policy.ts";

/** The marker selects finite preflight; native unit/cgroup validation proves service ownership.
 * The entry consumes the marker before importing the CLI so provider children cannot inherit it. */
export const preflightLocalSupervisorService = (configPath: string) =>
  Effect.gen(function* () {
    if (process.env.BIGBUD_MODE !== "remote" || process.argv.length !== 2)
      return yield* Effect.fail(
        new Error("Account service requires remote mode without CLI overrides."),
      );
    const { config } = yield* Effect.tryPromise(() =>
      readLocalSupervisorServiceConfig({ homeDir: homedir(), configPath }),
    );
    const token = yield* Effect.tryPromise(() =>
      readLocalSupervisorServiceFile(join(dirname(configPath), "client-token"), 4096),
    );
    const supplied = process.env.BIGBUD_AUTH_TOKEN ?? "";
    if (
      !/^[!-~]+$/.test(token) ||
      Buffer.byteLength(supplied) !== Buffer.byteLength(token) ||
      !timingSafeEqual(Buffer.from(supplied), Buffer.from(token)) ||
      process.env.BIGBUD_HOME !== config.backend_home ||
      process.env.BIGBUD_NO_BROWSER !== "true" ||
      process.env.BIGBUD_AUTO_BOOTSTRAP_PROJECT_FROM_CWD !== "false"
    )
      return yield* Effect.fail(
        new Error("Account service environment does not match its private configuration."),
      );
    const flags: CliServerFlags = {
      mode: Option.some("remote"),
      baseDir: Option.some(config.backend_home),
      authToken: Option.some(token),
      noBrowser: Option.some(true),
      autoBootstrapProjectFromCwd: Option.some(false),
      port: Option.none(),
      host: Option.none(),
      cwd: Option.none(),
      devUrl: Option.none(),
      bootstrapFd: Option.none(),
      logWebSocketEvents: Option.none(),
    };
    const serverConfig = yield* resolveServerConfig(flags, Option.none());
    return yield* runLocalSupervisorServicePreflight({
      config: serverConfig,
      requireExistingIdentity: true,
      validateIdentity: (identity) => {
        if (
          identity.authority.authorityId !== config.authority ||
          identity.installationFingerprint !== config.expected_installation_fingerprint
        )
          throw new Error("Account service identity does not match its reserved installation.");
      },
      operation: async ({ identity, owners }, signal) => {
        const reconciler = makeLocalSupervisorBootReconciler({
          control: makeLocalSupervisorControl({
            targetId: localSupervisorTarget(identity.authority.authorityId),
            homeDir: config.home,
          }),
          owners,
          configPath,
          identity,
        });
        try {
          await reconciler.reconcile(signal);
          return bindAccountServiceIdentity(serverConfig, identity);
        } finally {
          reconciler.close();
        }
      },
    });
  });
