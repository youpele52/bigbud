import type { OpencodeV2Client } from "./Client.ts";
import type { V2SharedConnection } from "./SharedService.descriptor.ts";

interface Binding {
  readonly descriptor: V2SharedConnection;
  readonly assertCurrent: () => void;
}
const bindings = new WeakMap<OpencodeV2Client, Binding>();

/** Borrowed connection composition binds exact transport identity; native API claims cannot register it. */
export function bindV2NativeCompatibility(client: OpencodeV2Client, binding: Binding) {
  if (bindings.has(client))
    throw new Error("V2 native client compatibility identity is already bound.");
  bindings.set(client, binding);
}
export function v2NativeCompatibilityBinding(client: OpencodeV2Client) {
  return bindings.get(client);
}
