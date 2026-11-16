import { Effect, Layer, Stream } from "effect";

import { BrowserManager, BrowserManagerError } from "../browser/Services/BrowserManager.ts";
import {
  VisibleBrowserControl,
  VisibleBrowserControlError,
  type VisibleBrowserControlShape,
  setVisibleBrowserControl,
} from "../browser/Services/VisibleBrowserControl.ts";
import { ComputerUse, ComputerUseError } from "../computer-use/Services/ComputerUse.ts";
import { CuaDriver, CuaDriverError } from "../computer-use/Services/CuaDriver.ts";
import { ComputerUseActivityLive } from "../computer-use/Layers/ComputerUseActivity.ts";
import { Open, OpenError } from "../utils/open.ts";
import { PtyAdapter, PtySpawnError } from "../terminal/Services/PTY.ts";

const message = "This facility is unavailable in the remote backend profile.";
const browserUnavailable = () => Effect.fail(new BrowserManagerError({ message }));

export const RemoteOpenLive = Layer.succeed(Open, {
  openBrowser: () => Effect.fail(new OpenError({ message })),
  openInEditor: () => Effect.fail(new OpenError({ message })),
  openInTerminal: () => Effect.fail(new OpenError({ message })),
  openPath: () => Effect.fail(new OpenError({ message })),
});

// Until the local Rust supervisor adapter is installed, never fall back to a backend-owned PTY.
export const RemoteUnavailablePtyLive = Layer.succeed(PtyAdapter, {
  spawn: () => Effect.fail(new PtySpawnError({ adapter: "remote", message })),
});

export const RemoteComputerUseLive = Layer.mergeAll(
  Layer.succeed(ComputerUse, {
    isActive: () => Effect.succeed(false),
    withThreadLease: () => Effect.fail(new ComputerUseError({ message })),
    execute: () => Effect.fail(new ComputerUseError({ message })),
    dispose: Effect.void,
  }),
  Layer.succeed(BrowserManager, {
    hasContext: () => Effect.succeed(false),
    launch: browserUnavailable,
    navigate: browserUnavailable,
    screenshot: browserUnavailable,
    click: browserUnavailable,
    drag: browserUnavailable,
    scroll: browserUnavailable,
    typeText: browserUnavailable,
    keyPress: browserUnavailable,
    wait: browserUnavailable,
    getPageInfo: browserUnavailable,
    getPageText: browserUnavailable,
    goBack: browserUnavailable,
    goForward: browserUnavailable,
    reload: browserUnavailable,
    close: () => Effect.void,
    closeAll: () => Effect.void,
  }),
  Layer.succeed(CuaDriver, {
    callTool: () => Effect.fail(new CuaDriverError({ message })),
    runDoctor: () => Effect.fail(new CuaDriverError({ message })),
    resetProxy: Effect.void,
    resetAfterUncertainAction: () => Effect.void,
    stopAllActivity: () => Effect.succeed("idle" as const),
    withExclusiveAccess: (effect) => effect,
    dispose: Effect.void,
  }),
  ComputerUseActivityLive,
);

export const remoteVisibleBrowserControl: VisibleBrowserControlShape = {
  hasThreadLease: () => Effect.succeed(false),
  resolveThreadLease: () => Effect.succeed(undefined),
  isAvailable: Effect.succeed(false),
  execute: () => Effect.fail(new VisibleBrowserControlError({ message })),
  complete: () => Effect.void,
  streamCommands: () => Stream.empty,
  reconcileThread: () => Effect.void,
  revokeLease: () => Effect.void,
  getLeases: () => Effect.succeed([]),
};

export const RemoteVisibleBrowserControlLive = Layer.effect(
  VisibleBrowserControl,
  Effect.acquireRelease(
    Effect.sync(() => {
      setVisibleBrowserControl(remoteVisibleBrowserControl);
      return remoteVisibleBrowserControl;
    }),
    () => Effect.sync(() => setVisibleBrowserControl(null)),
  ),
);
