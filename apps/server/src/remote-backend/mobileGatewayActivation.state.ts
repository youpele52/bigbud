/** Orchestration state only: neither acknowledgement nor stop() is native exit/readiness proof. */
export interface MobileActivationAcknowledgement {
  readonly requestId: string | null;
  readonly status: "disabled" | "accepted" | "selected" | "retired" | "unavailable";
}
/** Owner status only; never readiness, exit or publication evidence. */
export type MobileActivationPhase = "idle" | "running" | "uncertain-detached" | "uncertain-repair";
export interface MobileActivationOutcomeSummary {
  readonly kind: string;
  readonly repairRequired: boolean;
  readonly at: string;
}
export interface MobileActivationControllerStatus {
  readonly phase: MobileActivationPhase;
  readonly lastOutcome: MobileActivationOutcomeSummary | null;
}
export interface MobileActivationStatus {
  readonly attached: boolean;
  readonly retiring: boolean;
  readonly stopping: boolean;
  /** `null` while unattached, or for a controller that reports no status. */
  readonly controller: MobileActivationControllerStatus | null;
}
export interface MobileActivationController {
  readonly activate: (input: unknown) => Promise<MobileActivationAcknowledgement>;
  readonly resume: () => Promise<MobileActivationAcknowledgement>;
  /** Actual controller must verify exact native revocation before this resolves. */
  readonly stop: () => Promise<void>;
  /** App retirement detaches/settles Node work; it must not kill the native child. */
  readonly close: () => Promise<void>;
  readonly status?: () => MobileActivationControllerStatus;
}
const unavailable = (): MobileActivationAcknowledgement => ({
  requestId: null,
  status: "unavailable",
});

export class MobileActivationState {
  private controller: MobileActivationController | undefined;
  private retiring: Promise<void> | undefined;
  private stopping: Promise<void> | undefined;
  private previouslyAttached = false;

  activate(input: unknown): Promise<MobileActivationAcknowledgement> {
    if (!this.controller || this.retiring || this.stopping) return Promise.resolve(unavailable());
    const controller = this.controller;
    return Promise.resolve().then(() =>
      this.controller === controller && !this.retiring && !this.stopping
        ? controller.activate(input)
        : unavailable(),
    );
  }
  resume(): Promise<MobileActivationAcknowledgement> {
    if (!this.controller || this.retiring || this.stopping) return Promise.resolve(unavailable());
    const controller = this.controller;
    return Promise.resolve().then(() =>
      this.controller === controller && !this.retiring && !this.stopping
        ? controller.resume()
        : unavailable(),
    );
  }
  status(): MobileActivationStatus {
    return {
      attached: this.controller !== undefined,
      retiring: this.retiring !== undefined,
      stopping: this.stopping !== undefined,
      controller: this.controller?.status?.() ?? null,
    };
  }
  stop(): Promise<void> {
    if (this.retiring)
      return Promise.reject(Error("Controller is detaching; native owner revocation is required."));
    if (this.stopping) return this.stopping;
    if (!this.controller) {
      // Virgin idle has no accepted work. After detach, absence cannot prove native cleanup.
      return this.previouslyAttached
        ? Promise.reject(
            Error("Detached controller cannot confirm original native lease revocation."),
          )
        : Promise.resolve();
    }
    const controller = this.controller;
    const stopping = Promise.resolve().then(controller.stop);
    this.stopping = stopping;
    void stopping.then(
      () => {
        if (this.stopping === stopping) this.stopping = undefined;
      },
      () => {},
    );
    return stopping;
  }

  /** Called only by later actual app attachment. This early object captures no Scope/resources. */
  attach(input: MobileActivationController): () => Promise<void> {
    if (this.controller || this.retiring || this.stopping)
      throw Error("Mobile activation controller requires settled prior ownership.");
    const controller = Object.freeze({
      activate: input.activate.bind(input),
      resume: input.resume.bind(input),
      stop: input.stop.bind(input),
      close: input.close.bind(input),
      ...(input.status ? { status: input.status.bind(input) } : {}),
    });
    this.controller = controller;
    this.previouslyAttached = true;
    let closing: Promise<void> | undefined;
    return () => {
      if (closing) return closing;
      const stop = this.stopping;
      closing = Promise.resolve().then(async () => {
        const stopped = stop ? await Promise.allSettled([stop]) : [];
        const detached = await Promise.allSettled([Promise.resolve().then(controller.close)]);
        if (this.controller === controller) this.controller = undefined;
        const failures = [...stopped, ...detached].flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        );
        if (failures.length)
          throw new AggregateError(failures, "Mobile activation retirement remains uncertain.");
      });
      this.retiring = closing;
      void closing.then(
        () => {
          if (this.retiring === closing) this.retiring = undefined;
        },
        () => {},
      );
      return closing;
    };
  }
}
