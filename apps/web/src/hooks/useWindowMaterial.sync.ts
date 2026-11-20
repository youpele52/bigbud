import type { DesktopBridge } from "@bigbud/contracts/server/ipc.ts";
import type { DesktopWindowMaterial } from "@bigbud/contracts/core/settings.ts";
import type { DesktopWindowMaterialState } from "@bigbud/contracts/server/ipc.windowMaterial.ts";

/** Subscribe before applying the preference; a late snapshot must never replace a live update. */
export function syncWindowMaterial(
  bridge: Pick<
    DesktopBridge,
    "setWindowMaterial" | "getWindowMaterialState" | "onWindowMaterialState"
  >,
  mode: DesktopWindowMaterial,
  onState: (state: DesktopWindowMaterialState) => void,
): () => void {
  const requestId = crypto.randomUUID();
  let disposed = false;
  let receivedUpdate = false;
  const unsubscribe = bridge.onWindowMaterialState?.((state) => {
    if (disposed || state.mode !== mode || state.requestId !== requestId) return;
    receivedUpdate = true;
    onState(state);
  });

  void bridge
    .setWindowMaterial(mode, requestId)
    .then(() => (disposed ? null : bridge.getWindowMaterialState?.()))
    .then((state) => {
      if (
        disposed ||
        receivedUpdate ||
        !state ||
        state.mode !== mode ||
        state.requestId !== requestId
      )
        return;
      onState(state);
    })
    .catch(() => undefined);

  return () => {
    disposed = true;
    unsubscribe?.();
  };
}
