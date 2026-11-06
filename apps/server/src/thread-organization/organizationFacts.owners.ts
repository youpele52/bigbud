import * as SqlClient from "effect/unstable/sql/SqlClient";
import { organizationEngagedUntil } from "./organizationEngagement.ts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { TerminalManager } from "../terminal/Services/Manager.ts";
import { ThreadShellRunner } from "../shell/Services/ThreadShellRunner.ts";
import type { OrganizationOwnerFacts } from "./organizationFacts.build.ts";

export const makeOrganizationOwnerFacts = Effect.gen(function* () {
  const sql = yield* Effect.serviceOption(SqlClient.SqlClient);
  const terminal = yield* Effect.serviceOption(TerminalManager);
  const shell = yield* Effect.serviceOption(ThreadShellRunner);
  return (threadId: string): Effect.Effect<OrganizationOwnerFacts> =>
    Effect.gen(function* () {
      const terminalFact =
        Option.isSome(terminal) && terminal.value.getThreadIdleWork
          ? yield* terminal.value
              .getThreadIdleWork(threadId)
              .pipe(
                Effect.catchCause(() =>
                  Effect.succeed({ state: "unknown" as const, quietSince: null }),
                ),
              )
          : { state: "unknown" as const, quietSince: null };
      const command =
        Option.isSome(shell) && shell.value.hasRunningCommand
          ? yield* shell.value.hasRunningCommand(threadId).pipe(
              Effect.map((busy) => (busy ? ("active" as const) : ("idle" as const))),
              Effect.catchCause(() => Effect.succeed("unknown" as const)),
            )
          : ("unknown" as const);
      const engagedUntilMs = Option.isSome(sql)
        ? organizationEngagedUntil(sql.value, threadId)
        : undefined;
      return {
        terminal: terminalFact,
        shell: command,
        ...(engagedUntilMs === undefined ? {} : { engagedUntilMs }),
      };
    });
});
