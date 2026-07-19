import { ServiceMap } from "effect";

import type { ServerProviderShape } from "../ServerProvider.ts";

export class CliProxyProvider extends ServiceMap.Service<CliProxyProvider, ServerProviderShape>()(
  "bigbud/provider/Services/CliProxyProvider",
) {}
