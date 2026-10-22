/**
 * Contract between `bun dev:desktop`'s launcher chain and the dev Electron app. Dev-only: packaged
 * builds never read these values and keep their own exit codes.
 */

/** Set by `scripts/dev-runner.ts` (dev:desktop only) so the launcher can end the whole session. */
export const DEV_RUNNER_PID_ENV = "BIGBUD_DEV_RUNNER_PID";

/**
 * Dev Electron exit codes the launcher (`apps/desktop/scripts/dev-electron.mjs`) interprets. Exit 0
 * is reserved for a user quit, which ends the dev session. The values are BSD `sysexits` codes,
 * which Electron itself never uses.
 */
/** Restart: relaunch under supervision instead of `app.relaunch()`. `EX_TEMPFAIL`. */
export const DEV_APP_RESTART_EXIT_CODE = 75;
/** Fatal startup error or uncaught main-process exception: stay idle until the next rebuild. */
export const DEV_APP_FATAL_EXIT_CODE = 70;
/** Another dev instance holds the single-instance lock: stay idle until the next rebuild. */
export const DEV_APP_DUPLICATE_INSTANCE_EXIT_CODE = 69;
