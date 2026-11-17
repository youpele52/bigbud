import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { MobileActivationRequestId } from "../remote-agent/mobileGatewayActivation.selection.schema.ts";
import {
  MobileGatewayConfiguration,
  validateMobileGatewayConfiguration,
} from "../remote-agent/mobileGatewayLifecycle.schema.ts";
import type { RemoteMobileNativeInputsValue } from "./mobileGatewayActivation.inputs.ts";
import {
  runNativeMobileActivation,
  type NativeMobileActivationOutcome,
  type NativeMobileActivationRequest,
  type NativeMobileActivationServices,
} from "./mobileGatewayActivation.launch.ts";
import type {
  MobileActivationAcknowledgement,
  MobileActivationController,
} from "./mobileGatewayActivation.state.ts";
import type { NativeMobileGatewaySessionSignals } from "./mobileGatewayNative.session.ts";

const ActivationInput = Schema.Struct({
  requestId: MobileActivationRequestId,
  configuration: MobileGatewayConfiguration,
});
export type MobileActivationLaunch = (
  request: NativeMobileActivationRequest,
  signals: NativeMobileGatewaySessionSignals,
  onSelected: () => void,
) => Promise<NativeMobileActivationOutcome>;

interface Running {
  readonly kind: "running";
  readonly request: NativeMobileActivationRequest;
  readonly detach: AbortController;
  readonly stop: AbortController;
  readonly acknowledged: Promise<MobileActivationAcknowledgement>;
  readonly done: Promise<NativeMobileActivationOutcome>;
}
/** `uncertain`: a child may still run (detached) or ownership needs repair; never relaunch. */
type Phase =
  | { readonly kind: "idle" }
  | Running
  | { readonly kind: "uncertain"; readonly reason: "detached" | "repair" };

const ack = (
  requestId: string | null,
  status: MobileActivationAcknowledgement["status"],
): MobileActivationAcknowledgement => ({ requestId, status });
/** Native ownership is settled: nothing launched, or the original exit was recorded. */
const settledOwnership = (outcome: NativeMobileActivationOutcome) =>
  outcome.kind === "exit-recorded" ||
  outcome.kind === "unavailable" ||
  outcome.kind === "disabled" ||
  (outcome.kind === "failed" && !outcome.repairRequired);
const uncertainty = (outcome: NativeMobileActivationOutcome) =>
  outcome.kind === "failed" ? outcome.cause : Error(`Native mobile gateway ${outcome.kind}.`);

function decodeActivation(input: unknown): NativeMobileActivationRequest {
  const decoded = Schema.decodeUnknownSync(ActivationInput)(input, { onExcessProperty: "error" });
  validateMobileGatewayConfiguration(decoded.configuration);
  return Object.freeze({
    requestId: decoded.requestId,
    configuration: Object.freeze({ ...decoded.configuration }),
  });
}

/**
 * One native activation at a time. Outcomes map honestly: a recorded exit (or work that never
 * reached Start) returns to idle; a detach or a repair-required failure leaves the controller
 * `uncertain`, which refuses relaunch and fails `stop` until successor recovery or repair. The
 * controller itself never removes intent, pins or runtime assets.
 */
export function createMobileActivationController(
  launch: MobileActivationLaunch,
  platform: NodeJS.Platform = process.platform,
): MobileActivationController {
  let phase: Phase = { kind: "idle" };

  const begin = (request: NativeMobileActivationRequest): Running => {
    const detach = new AbortController();
    const stop = new AbortController();
    let selected = false;
    let onSelected!: () => void;
    const selection = new Promise<void>((resolve) => {
      onSelected = () => {
        selected = true;
        resolve();
      };
    });
    const done = Promise.resolve()
      .then(() => launch(request, { detach: detach.signal, stop: stop.signal }, onSelected))
      .catch(
        (cause: unknown): NativeMobileActivationOutcome => ({
          kind: "failed",
          repairRequired: selected,
          cause,
        }),
      );
    const acknowledged = Promise.race([
      selection.then(() => ack(request.requestId, "accepted")),
      done.then((outcome) => {
        if (selected) return ack(request.requestId, "accepted");
        if (outcome.kind === "unavailable" || outcome.kind === "disabled")
          return ack(null, outcome.kind);
        throw uncertainty(outcome);
      }),
    ]);
    const running: Running = { kind: "running", request, detach, stop, acknowledged, done };
    void done.then((outcome) => {
      if (phase !== running) return;
      phase = settledOwnership(outcome)
        ? { kind: "idle" }
        : { kind: "uncertain", reason: outcome.kind === "detached" ? "detached" : "repair" };
    });
    return running;
  };

  return Object.freeze({
    activate: async (input: unknown) => {
      if (platform !== "linux") return ack(null, "unavailable");
      const request = decodeActivation(input);
      if (phase.kind === "uncertain") return ack(null, "unavailable");
      if (phase.kind === "running") {
        const current = phase.request;
        if (
          current.requestId === request.requestId &&
          current.configuration.externalOrigin === request.configuration.externalOrigin &&
          current.configuration.port === request.configuration.port
        )
          return phase.acknowledged;
        throw Error("Another mobile gateway activation owns the native lease.");
      }
      const running = begin(request);
      phase = running;
      return running.acknowledged;
    },
    // Successor adoption is increment 5; until then nothing foreign is ever adopted.
    resume: async () => ack(null, "unavailable"),
    stop: async () => {
      if (phase.kind === "idle") return;
      if (phase.kind === "uncertain")
        throw Error("Original native mobile gateway exit cannot be confirmed by this controller.");
      phase.stop.abort(Error("Mobile gateway stop requested."));
      const outcome = await phase.done;
      if (!settledOwnership(outcome)) throw uncertainty(outcome);
    },
    close: async () => {
      if (phase.kind !== "running") return;
      phase.detach.abort(Error("Mobile activation controller is retiring."));
      const outcome = await phase.done;
      // A detach hands the child to a successor; only repair-required work is uncertain here.
      if (outcome.kind === "failed" && outcome.repairRequired) throw outcome.cause;
    },
  });
}

/** Binds the controller to the real activation pipeline under the app's captured services. */
export const makeNativeMobileActivationController = Effect.fn(
  "makeNativeMobileActivationController",
)(function* (inputs: RemoteMobileNativeInputsValue) {
  const run = Effect.runPromiseWith(yield* Effect.services<NativeMobileActivationServices>());
  return createMobileActivationController((request, signals, onSelected) =>
    run(runNativeMobileActivation(inputs, request, signals, onSelected)),
  );
});
