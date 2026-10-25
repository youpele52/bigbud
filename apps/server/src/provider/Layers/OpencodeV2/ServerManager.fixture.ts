import { OpencodeV2ServerManager } from "./ServerManager.ts";
import { startOwnedV2Process } from "./ServerManager.child.ts";

/** Owned private launch defaults are exclusively disposable fixture infrastructure, never production acquisition. */
export class OpencodeV2IsolatedFixtureManager extends OpencodeV2ServerManager {
  constructor(
    options: Omit<ConstructorParameters<typeof OpencodeV2ServerManager>[0], "start"> &
      Partial<Pick<ConstructorParameters<typeof OpencodeV2ServerManager>[0], "start">>,
  ) {
    super({ ...options, start: options.start ?? startOwnedV2Process });
  }
}
