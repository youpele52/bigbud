import { ServiceMap } from "effect";

import type { ProviderAdapterError } from "../../Errors.ts";
import type { ProviderAdapterShape } from "../ProviderAdapter.ts";

/** Experimental adapter tag kept separate so its removal is mechanically simple. */
export interface CliProxyAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  readonly provider: "cliProxy";
}

export class CliProxyAdapter extends ServiceMap.Service<CliProxyAdapter, CliProxyAdapterShape>()(
  "bigbud/provider/Services/CliProxyAdapter",
) {}
