import { ServiceMap } from "effect";
import type { ProviderAdapterError } from "../../Errors.ts";
import type { ProviderAdapterShape } from "../ProviderAdapter.ts";

export interface KilocodeAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  readonly provider: "kilocode";
}

export class KilocodeAdapter extends ServiceMap.Service<KilocodeAdapter, KilocodeAdapterShape>()(
  "t3/provider/Services/KilocodeAdapter",
) {}
