import { ServiceMap } from "effect";

import type { OpencodeV2ServerManager as Manager } from "../../Layers/OpencodeV2/ServerManager.ts";

export class OpencodeV2ServerManager extends ServiceMap.Service<OpencodeV2ServerManager, Manager>()(
  "bigbud/provider/OpencodeV2ServerManager",
) {}
