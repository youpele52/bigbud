import { Layer } from "effect";

import { BrowserManagerLive } from "./browser/Layers/BrowserManager";
import { ComputerUseLive } from "./computer-use/Layers/ComputerUse";
import { ComputerUseActivityLive } from "./computer-use/Layers/ComputerUseActivity.ts";
import { CuaDriverLive } from "./computer-use/Layers/CuaDriver";
import { OpenLive } from "./utils/open";

/**
 * Computer use for the whole server. Referenced once by the orchestration engine (which records
 * actions into the activity registry) and once in the merged runtime (where the WebSocket Stop
 * handler reads the registry and the Cua driver); being one layer value, it is built once, so
 * both see the same registry and driver.
 */
export const ComputerUseLayerLive = ComputerUseLive.pipe(
  Layer.provideMerge(BrowserManagerLive),
  Layer.provideMerge(Layer.mergeAll(CuaDriverLive, ComputerUseActivityLive)),
  Layer.provide(OpenLive),
);
