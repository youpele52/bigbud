import * as Exit from "effect/Exit";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import { expect, it } from "vitest";
import { mobileGatewayOwnerCleanupConfirmed } from "./mobileGatewayOwner.exit.ts";
import { MobileGatewayProcessError } from "./mobileGatewayProcess.lifetime.ts";

it("permits a settled callback failure but retains an explicit uncertain cleanup fence", () => {
  const failed = (repairRequired: boolean) =>
    Exit.fail(
      new MobileGatewayProcessError({
        message: "Fixture cleanup outcome",
        repairRequired,
      }),
    );
  expect(mobileGatewayOwnerCleanupConfirmed(failed(false))).toBe(true);
  expect(mobileGatewayOwnerCleanupConfirmed(failed(true))).toBe(false);
  expect(mobileGatewayOwnerCleanupConfirmed(Exit.fail(new Error("unknown cleanup")))).toBe(false);
});

it("does not hide a finalizer defect alongside an otherwise retryable process error", async () => {
  const exit = await Effect.runPromise(
    Effect.exit(
      Effect.fail(
        new MobileGatewayProcessError({ message: "Settled callback", repairRequired: false }),
      ).pipe(Effect.ensuring(Effect.die("unconfirmed teardown"))),
    ),
  );
  expect(mobileGatewayOwnerCleanupConfirmed(exit)).toBe(false);
});

it("allows pure interruption only after the process helper has settled its finalizers", async () => {
  const exit = await Effect.runPromise(Effect.exit(Effect.interrupt));
  expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
  expect(mobileGatewayOwnerCleanupConfirmed(exit)).toBe(true);
});
