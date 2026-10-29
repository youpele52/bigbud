import { ServiceMap } from "effect";

import type { ServerProviderShape } from "../ServerProvider";

export interface MuseProviderShape extends ServerProviderShape {}

export class MuseProvider extends ServiceMap.Service<MuseProvider, MuseProviderShape>()(
  "bigbud/provider/Services/MuseProvider",
) {}
