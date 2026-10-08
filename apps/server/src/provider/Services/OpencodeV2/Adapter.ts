import { ServiceMap } from "effect";

import type { ProviderAdapterError } from "../../Errors.ts";
import type { ProviderAdapterShape } from "../ProviderAdapter.ts";

export interface OpencodeV2AdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  readonly provider: "opencodeV2";
}

export class OpencodeV2Adapter extends ServiceMap.Service<
  OpencodeV2Adapter,
  OpencodeV2AdapterShape
>()("bigbud/provider/OpencodeV2Adapter") {}
