import { Effect, Layer, Ref, ServiceMap } from "effect";

export class RemoteTerminalAvailability extends ServiceMap.Service<
  RemoteTerminalAvailability,
  {
    readonly available: Effect.Effect<boolean>;
    readonly markAvailable: Effect.Effect<void>;
  }
>()("bigbud/remote-backend/TerminalAvailability") {}

export const RemoteTerminalAvailabilityLive = Layer.effect(
  RemoteTerminalAvailability,
  Effect.gen(function* () {
    const available = yield* Ref.make(false);
    return { available: Ref.get(available), markAvailable: Ref.set(available, true) };
  }),
);
