import { ServiceMap } from "effect";

import type { ServerProviderShape } from "../ServerProvider.ts";

export interface DevinProviderShape extends ServerProviderShape {}

export class DevinProvider extends ServiceMap.Service<DevinProvider, DevinProviderShape>()(
  "bigcode/provider/Services/DevinProvider",
) {}
