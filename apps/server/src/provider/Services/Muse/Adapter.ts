/**
 * MuseAdapter - Muse Code implementation of the generic provider adapter contract.
 *
 * Shape/tag declaration only (following Services/Claude precedent); the
 * implementation lives in provider/Layers/Muse. Muse speaks MSP over an
 * owned `muse serve` child through the official low-level SDK connection
 * because the SDK facade cannot supply per-session MCP configuration.
 *
 * @module MuseAdapter
 */
import { ServiceMap } from "effect";

import type { ProviderAdapterError } from "../../Errors.ts";
import type { ProviderAdapterShape } from "../ProviderAdapter.ts";

export interface MuseAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  readonly provider: "muse";
}

export class MuseAdapter extends ServiceMap.Service<MuseAdapter, MuseAdapterShape>()(
  "bigbud/provider/Services/MuseAdapter",
) {}
