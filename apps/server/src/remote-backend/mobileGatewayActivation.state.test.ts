import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import {
  MobileActivationState,
  type MobileActivationController,
  type MobileActivationAcknowledgement,
} from "./mobileGatewayActivation.state.ts";
import {
  RemoteMobileGatewayActivation,
  RemoteMobileGatewayActivationLive,
  registeredMobileGatewayActivationState,
} from "./mobileGatewayActivation.service.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const acknowledgement: MobileActivationAcknowledgement = {
  requestId: "fixture-only",
  status: "accepted",
};
function controller(
  overrides: Partial<MobileActivationController> = {},
): MobileActivationController {
  return {
    activate: async () => acknowledgement,
    resume: async () => acknowledgement,
    stop: async () => {},
    close: async () => {},
    ...overrides,
  };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("pure early mobile activation control", () => {
  it("is unavailable without attachment before inspecting input or doing optional work", async () => {
    const service = await Effect.runPromise(
      Effect.service(RemoteMobileGatewayActivation).pipe(
        Effect.provide(RemoteMobileGatewayActivationLive),
      ),
    );
    const input = new Proxy(
      {},
      {
        get: () => {
          throw Error("Input must not be inspected.");
        },
      },
    );
    expect(await Effect.runPromise(service.activate(input))).toEqual({
      requestId: null,
      status: "unavailable",
    });
    expect(await Effect.runPromise(service.resume)).toEqual({
      requestId: null,
      status: "unavailable",
    });
    await Effect.runPromise(service.stop);
    expect(() => registeredMobileGatewayActivationState({ ...service })).toThrow(/Original early/);
  });
  it("blocks dequeued activation/resume after app retirement starts", async () => {
    const state = new MobileActivationState();
    let calls = 0;
    const close = state.attach(
      controller({
        activate: async () => {
          calls++;
          return acknowledgement;
        },
        resume: async () => {
          calls++;
          return acknowledgement;
        },
      }),
    );
    const starting = state.activate({}),
      resuming = state.resume(),
      closing = close();
    expect(await starting).toEqual({ requestId: null, status: "unavailable" });
    expect(await resuming).toEqual({ requestId: null, status: "unavailable" });
    await closing;
    expect(calls).toBe(0);
    await expect(state.stop()).rejects.toThrow(/Detached controller/);
  });
  it("joins explicit stop and prevents new work until it settles", async () => {
    const state = new MobileActivationState(),
      stop = deferred();
    let calls = 0;
    state.attach(
      controller({
        stop: async () => {
          calls++;
          await stop.promise;
        },
      }),
    );
    const first = state.stop();
    expect(state.stop()).toBe(first);
    expect(await state.activate({})).toEqual({ requestId: null, status: "unavailable" });
    expect(await state.resume()).toEqual({ requestId: null, status: "unavailable" });
    stop.resolve();
    await first;
    expect(calls).toBe(1);
    expect(await state.activate({})).toEqual(acknowledgement);
  });
  it("keeps the original controller method references", async () => {
    const state = new MobileActivationState(),
      input = controller();
    const close = state.attach(input);
    Object.defineProperty(input, "activate", {
      value: () => {
        throw Error("Foreign replacement.");
      },
    });
    expect(await state.activate({})).toEqual(acknowledgement);
    await close();
  });
  it("leaves no attachment behind when controller construction fails", async () => {
    const state = new MobileActivationState(),
      broken = controller();
    Object.defineProperty(broken, "close", {
      get: () => {
        throw Error("Construction failed.");
      },
    });
    expect(() => state.attach(broken)).toThrow(/Construction failed/);
    await state.stop();
    const close = state.attach(controller());
    expect(await state.activate({})).toEqual(acknowledgement);
    await close();
  });
  it("settles an accepted stop before app detach and refuses overlap", async () => {
    const state = new MobileActivationState(),
      stop = deferred(),
      detached = deferred();
    const order: string[] = [];
    const close = state.attach(
      controller({
        stop: async () => {
          order.push("stop");
          await stop.promise;
          order.push("stopped");
        },
        close: async () => {
          order.push("detach");
          await detached.promise;
        },
      }),
    );
    const stopping = state.stop(),
      closing = close();
    expect(close()).toBe(closing);
    await tick();
    expect(order).toEqual(["stop"]);
    expect(() => state.attach(controller())).toThrow(/prior ownership/);
    await expect(state.stop()).rejects.toThrow(/detaching/);
    stop.resolve();
    await stopping;
    await tick();
    expect(order).toEqual(["stop", "stopped", "detach"]);
    expect(() => state.attach(controller())).toThrow(/prior ownership/);
    detached.resolve();
    await closing;
    const newClose = state.attach(controller());
    await newClose();
  });
  it("detaches Node work after failed stop but retains the uncertainty fence", async () => {
    const state = new MobileActivationState();
    let detached = false;
    const close = state.attach(
      controller({
        stop: async () => {
          throw Error("Original native exit unknown.");
        },
        close: async () => {
          detached = true;
        },
      }),
    );
    await expect(state.stop()).rejects.toThrow(/exit unknown/);
    await expect(close()).rejects.toThrow(/retirement remains uncertain/);
    expect(detached).toBe(true);
    expect(() => state.attach(controller())).toThrow(/prior ownership/);
    expect(await state.resume()).toEqual({ requestId: null, status: "unavailable" });
  });
  it("does not turn failed detach into permission for another controller", async () => {
    const state = new MobileActivationState();
    const close = state.attach(
      controller({
        close: async () => {
          throw Error("Node IO did not settle.");
        },
      }),
    );
    await expect(close()).rejects.toThrow(/retirement remains uncertain/);
    expect(() => state.attach(controller())).toThrow(/prior ownership/);
    expect(await state.activate({})).toEqual({ requestId: null, status: "unavailable" });
  });
  it("request interruption detaches acknowledgement while app-owned work still settles", async () => {
    const service = await Effect.runPromise(
      Effect.service(RemoteMobileGatewayActivation).pipe(
        Effect.provide(RemoteMobileGatewayActivationLive),
      ),
    );
    const state = registeredMobileGatewayActivationState(service),
      started = deferred(),
      work = deferred();
    let finished = false,
      stopped = false;
    const close = state.attach(
      controller({
        activate: async () => {
          started.resolve();
          await work.promise;
          finished = true;
          return acknowledgement;
        },
        stop: async () => {
          stopped = true;
        },
        close: async () => {
          await work.promise;
        },
      }),
    );
    const fiber = Effect.runFork(service.activate({}));
    await started.promise;
    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(finished).toBe(false);
    expect(stopped).toBe(false);
    let retired = false;
    const retiring = close().then(() => {
      retired = true;
    });
    await tick();
    expect(retired).toBe(false);
    work.resolve();
    await retiring;
    expect(finished).toBe(true);
  });
});
