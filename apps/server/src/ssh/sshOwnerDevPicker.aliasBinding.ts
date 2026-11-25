import type { SshAliasDescriptorCheck } from "../persistence/Layers/SshAliasDescriptorBindings.ts";
import { SshOwnerDevPickerError } from "./sshOwnerDevPicker.errors.ts";

/** Profile-scoped store for the owner-resolved alias descriptor approved for this target. */
export interface SshOwnerDevAliasBinding {
  check(descriptor: Uint8Array): Promise<SshAliasDescriptorCheck>;
  approve(descriptor: Uint8Array, mode: "firstUse" | "reapprove"): Promise<SshAliasDescriptorCheck>;
}

const aliasChanged = () =>
  new SshOwnerDevPickerError(
    "aliasChanged",
    "The settings for this SSH alias changed since this workspace was saved. Nothing was sent to the new destination. Review the alias, then choose Connect to approve the changed settings.",
  );

const descriptorOf = (client: { readonly aliasDescriptor?: Uint8Array | undefined }) => {
  const descriptor = client.aliasDescriptor;
  if (descriptor?.length !== 32) {
    // A selected binding needs the owner's own resolution; never derive one locally.
    throw new SshOwnerDevPickerError(
      "configUnsupported",
      "The development SSH owner did not report the resolved alias settings.",
    );
  }
  return descriptor;
};

const sameBytes = (left: Uint8Array | undefined, right: Uint8Array) =>
  left !== undefined && Buffer.from(left).equals(right);

/**
 * Saved-alias retargeting rule. A changed descriptor fails closed before any owner request that
 * could dial. Only an explicit Connect re-approves, and only the exact descriptor that this picker
 * already presented as changed; a save never overwrites an existing approval.
 */
export function makeAliasDescriptorGuard(binding: SshOwnerDevAliasBinding | undefined) {
  let presented: Uint8Array | undefined;
  return {
    async admit(client: { readonly aliasDescriptor?: Uint8Array | undefined }) {
      if (!binding) return;
      const descriptor = descriptorOf(client);
      if ((await binding.check(descriptor)) !== "changed") return;
      presented = Uint8Array.from(descriptor);
      throw aliasChanged();
    },
    async recordSave(client: { readonly aliasDescriptor?: Uint8Array | undefined }) {
      if (!binding) return;
      if ((await binding.approve(descriptorOf(client), "firstUse")) !== "match")
        throw aliasChanged();
    },
    async reapproveOnConnect(client: { readonly aliasDescriptor?: Uint8Array | undefined }) {
      if (!binding || presented === undefined) return;
      const descriptor = descriptorOf(client);
      const approved = sameBytes(presented, descriptor);
      presented = undefined;
      if (approved) await binding.approve(descriptor, "reapprove");
    },
  };
}
