import * as Effect from "effect/Effect";
import * as Command from "effect/unstable/cli/Command";
import * as Flag from "effect/unstable/cli/Flag";
import { RemoteBackendAuthorityId } from "@bigbud/contracts/server/remoteBackendHandshake";
import {
  runBackendSetupCli,
  runBackendNativeCli,
  type BackendNativeAction,
} from "./cli.backend.operations.ts";
import { describeBackendFailure, type BackendCliAction } from "./cli.backend.failure.ts";

function report<A, E, R>(
  action: BackendCliAction,
  operation: Effect.Effect<A, E, R>,
  print: (value: A) => void,
) {
  return operation.pipe(
    Effect.tap((value) => Effect.sync(() => print(value))),
    Effect.catchCause((cause) =>
      Effect.sync(() => {
        const reason = describeBackendFailure(cause, action);
        process.stderr.write(
          `bigbud backend: Operation unavailable or incomplete. Preserve its state and inspect status before retrying.\n${reason ? `${reason}\n` : ""}`,
        );
        process.exitCode = 1;
      }),
    ),
  );
}
const confirmationRequired = (flag: string) =>
  Effect.sync(() => {
    process.stderr.write(`bigbud backend: Explicit ${flag} is required.\n`);
    process.exitCode = 1;
  });
// Explicit start/stop never change boot policy, so boot-startup consent is refused, not ignored.
const startupConsentRefused = Effect.sync(() => {
  process.stderr.write(
    "bigbud backend: start and stop take no --confirm-startup; use enable for boot startup.\n",
  );
  process.exitCode = 1;
});
const setup = Command.make("setup", {
  graphRoot: Flag.string("graph-root").pipe(
    Flag.withDescription(
      "Canonical private directory containing the complete signed executable graph.",
    ),
  ),
  graphManifest: Flag.string("graph-manifest").pipe(
    Flag.withDescription("Owner-private signed graph JSON outside the graph directory."),
  ),
  rustManifest: Flag.string("rust-manifest").pipe(
    Flag.withDescription("Owner-private signed Rust artifact manifest."),
  ),
  trustedKeys: Flag.string("trusted-keys").pipe(
    Flag.withDescription(
      "Owner-private JSON map of pinned Ed25519 PUBLIC keys, separate from the graph.",
    ),
  ),
  backendHome: Flag.string("backend-home").pipe(
    Flag.withDescription("Private backend data home, separate from the executable graph."),
  ),
  requestId: Flag.string("request-id").pipe(
    Flag.withDescription("Stable lowercase UUIDv4 identifying this explicit setup attempt."),
  ),
  confirmFreshSetup: Flag.boolean("confirm-fresh-setup"),
  restart: Flag.choice("restart", ["on-failure", "never"]).pipe(Flag.withDefault("on-failure")),
}).pipe(
  Command.withDescription(
    "Configure a fresh Linux account backend and admit its signed Rust runtime. Backend startup remains disabled.",
  ),
  Command.withHandler((input) =>
    !input.confirmFreshSetup
      ? confirmationRequired("--confirm-fresh-setup")
      : report("setup", runBackendSetupCli(input), (result) => {
          process.stdout.write(
            `Configured authority: ${result.authorityId}\nRequest: ${result.requestId}\nBackend startup remains disabled.\n`,
          );
        }),
  ),
);
const authority = () => Flag.string("authority").pipe(Flag.withSchema(RemoteBackendAuthorityId));
function native(
  name: "status" | "enable" | "disable-boot" | "start" | "stop",
  action: BackendNativeAction,
  description: string,
) {
  return Command.make(name, {
    authorityId: authority(),
    confirmStartup: Flag.boolean("confirm-startup"),
  }).pipe(
    Command.withDescription(description),
    Command.withHandler((input) =>
      action === "enable" && !input.confirmStartup
        ? confirmationRequired("--confirm-startup")
        : (action === "start" || action === "stop") && input.confirmStartup
          ? startupConsentRefused
          : report(name, runBackendNativeCli({ ...input, action }), (result) => {
              if (action === "status")
                process.stdout.write(
                  `${result.output.trim()}\nBackend readiness is not assessed by unit status.\n`,
                );
              // The native launcher reports observed unit states and what was preserved.
              else if (action === "start" || action === "stop")
                process.stdout.write(`${result.output.trim()}\n`);
              else
                process.stdout.write(
                  action === "enable"
                    ? "Backend startup requested. Inspect status to confirm its state.\n"
                    : "Automatic startup disabled. Running work continues.\n",
                );
            }),
    ),
  );
}
export const backendCommand = Command.make("backend").pipe(
  Command.withDescription("Configure and inspect this Linux account's remote backend services."),
  Command.withSubcommands([
    setup,
    native(
      "status",
      "status",
      "Inspect the configured user units without starting or repairing them.",
    ),
    native(
      "enable",
      "enable",
      "Explicitly enable and request backend startup after verified finite preflight.",
    ),
    native("disable-boot", "disable", "Disable automatic startup without stopping current work."),
    native(
      "start",
      "start",
      "Start the staged backend for this session without enabling boot startup or lingering.",
    ),
    native(
      "stop",
      "stop",
      "Stop the backend and Rust units, ending their work; boot startup and data are unchanged.",
    ),
  ]),
);
