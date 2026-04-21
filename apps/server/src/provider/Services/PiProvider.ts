import { ServiceMap } from "effect";

import type { ServerProviderShape } from "./ServerProvider";

export interface PiProviderShape extends ServerProviderShape {}

export class PiProvider extends ServiceMap.Service<PiProvider, PiProviderShape>()(
  "t3/provider/Services/PiProvider",
) {}
