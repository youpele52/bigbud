import { ServiceMap, type Effect } from "effect";
import type {
  ServerOpencodeV2ThreadToolsSetupInput,
  ServerOpencodeV2ThreadToolsSetupResult,
} from "@bigbud/contracts/server/server.opencodeV2ThreadToolsSetup";

export interface V2ThreadToolsSetupShape {
  readonly get: (
    input: ServerOpencodeV2ThreadToolsSetupInput,
  ) => Effect.Effect<ServerOpencodeV2ThreadToolsSetupResult>;
}
export class V2ThreadToolsSetup extends ServiceMap.Service<
  V2ThreadToolsSetup,
  V2ThreadToolsSetupShape
>()("bigbud/provider/OpencodeV2/ThreadToolsSetup") {}
