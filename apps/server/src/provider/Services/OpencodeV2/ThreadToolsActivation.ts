import * as ServiceMap from "effect/ServiceMap";
import type { V2ThreadToolsActivation } from "../../Layers/OpencodeV2/PluginSetup.activation.ts";

export class ThreadToolsActivation extends ServiceMap.Service<
  ThreadToolsActivation,
  V2ThreadToolsActivation
>()("bigbud/provider/OpencodeV2/ThreadToolsActivation") {}
