import type { V2PureJson } from "./Orchestration.implementation.types.ts";
import type {
  V2PureAction as PreviousAction,
  V2CanonicalBody as PreviousBody,
} from "./Orchestration.implementation.types.v3.ts";

export type V2PureAction = PreviousAction | "set_elevator_summary";
export interface V2CanonicalBody extends Omit<PreviousBody, "action"> {
  readonly action: PreviousBody["action"] | "set_elevator_summary";
  readonly summary?: string;
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
export interface V2ThreadImplementation extends V2PureThreadHandler {
  readonly implementationDigest: string;
  readonly bootstrapAbi: string;
  readonly schemaDigest: string;
  readonly canonicalRequestAbi: string;
  readonly resultEncoding: string;
}
