/** Provider-level attachment admission, independent of model vision or workspace coding tools. */
export interface ProviderAttachmentPolicy {
  readonly supported: boolean;
  readonly unavailableReason?: string;
}

const supported: ProviderAttachmentPolicy = { supported: true };
const museUnsupported: ProviderAttachmentPolicy = {
  supported: false,
  unavailableReason:
    "Muse Code does not accept attachments in bigbud yet; remove attachments or choose another provider.",
};
/** Delivery is prepared per execution target; Muse is the scoped blanket exclusion. */
export function providerAttachmentPolicy(provider: string | undefined): ProviderAttachmentPolicy {
  return provider === "muse" ? museUnsupported : supported;
}

/** Reject original attachments before canonical reference expansion or native mutations. */
export function providerAttachmentIssue(
  provider: string | undefined,
  attachments: ReadonlyArray<unknown> | undefined,
): string | undefined {
  return attachments?.length ? providerAttachmentPolicy(provider).unavailableReason : undefined;
}
