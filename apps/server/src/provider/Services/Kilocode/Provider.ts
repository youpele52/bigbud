import { ServiceMap } from "effect";
import type { ServerProviderShape } from "../ServerProvider";

export interface KilocodeProviderShape extends ServerProviderShape {}

export class KilocodeProvider extends ServiceMap.Service<KilocodeProvider, KilocodeProviderShape>()(
  "t3/provider/Services/KilocodeProvider",
) {}
