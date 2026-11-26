import type { V2PureJson } from "./Orchestration.implementation.types.ts";
import type {
  V2CanonicalBody as PreviousBody,
  V2PureAction as PreviousAction,
  V2ThreadImplementation as PreviousImplementation,
} from "./Orchestration.implementation.types.v5.ts";

export type V2PureAction = PreviousAction | "list_available_models";
export interface V2CanonicalBody extends Omit<PreviousBody, "action"> {
  readonly action: PreviousBody["action"] | "list_available_models";
  readonly modelSelection?: V2PureJson;
}
export interface V2PureThreadHandler {
  readonly prepare: (value: {
    readonly action: V2PureAction;
    readonly input: Readonly<Record<string, V2PureJson>>;
    readonly callerThreadId: string;
  }) => V2CanonicalBody;
  readonly interpret: (value: {
    readonly action: V2PureAction;
    readonly canonicalResult: V2PureJson;
  }) => V2PureJson;
}
export type V2ThreadImplementation = Omit<PreviousImplementation, keyof V2PureThreadHandler> &
  V2PureThreadHandler;
