import { Effect, Schema } from "effect";

import { AutomationScheduleNotFoundError, toPersistenceSqlError } from "../Errors.ts";

export const mapAutomationSchedulePersistenceError =
  (operation: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.mapError((cause) =>
        toPersistenceSqlError(`AutomationScheduleRepository.${operation}:query`)(cause),
      ),
    );

export const mapAutomationSchedulePersistenceErrorAllowNotFound =
  (operation: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.mapError((cause) =>
        Schema.is(AutomationScheduleNotFoundError)(cause)
          ? cause
          : toPersistenceSqlError(`AutomationScheduleRepository.${operation}:query`)(cause),
      ),
    );
