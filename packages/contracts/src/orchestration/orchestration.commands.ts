import { Schema } from "effect";
import {
  ClientOrchestrationCommand as ClientOrchestrationCommandSchema,
  DispatchableClientOrchestrationCommand as DispatchableClientOrchestrationCommandSchema,
  ProjectCreateCommand,
  ThreadPinCommand,
  ThreadShellRunCommand,
  ThreadTurnStartBootstrap as ThreadTurnStartBootstrapSchema,
  ThreadTurnStartCommand,
  ThreadUnpinCommand,
} from "./orchestration.commands.client";
import { InternalOrchestrationCommand as InternalOrchestrationCommandSchema } from "./orchestration.commands.internal";

export const ClientOrchestrationCommand = ClientOrchestrationCommandSchema;
export type ClientOrchestrationCommand = typeof ClientOrchestrationCommandSchema.Type;
export const DispatchableClientOrchestrationCommand = DispatchableClientOrchestrationCommandSchema;
export type DispatchableClientOrchestrationCommand =
  typeof DispatchableClientOrchestrationCommandSchema.Type;
export {
  ProjectCreateCommand,
  ThreadPinCommand,
  ThreadShellRunCommand,
  ThreadTurnStartCommand,
  ThreadUnpinCommand,
};
export const ThreadTurnStartBootstrap = ThreadTurnStartBootstrapSchema;
export type ThreadTurnStartBootstrap = typeof ThreadTurnStartBootstrapSchema.Type;
export const InternalOrchestrationCommand = InternalOrchestrationCommandSchema;
export type InternalOrchestrationCommand = typeof InternalOrchestrationCommandSchema.Type;

export const OrchestrationCommand = Schema.Union([
  DispatchableClientOrchestrationCommandSchema,
  InternalOrchestrationCommandSchema,
]);
export type OrchestrationCommand = typeof OrchestrationCommand.Type;
