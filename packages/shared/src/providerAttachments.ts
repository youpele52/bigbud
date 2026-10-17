/** Provider-level attachment admission, independent of model vision or workspace coding tools. */
export interface ProviderAttachmentPolicy {
  readonly supported: boolean;
  readonly unavailableReason?: string;
}

const supported: ProviderAttachmentPolicy = { supported: true };
/** Delivery is prepared per execution target; no provider has a blanket attachment exclusion. */
export function providerAttachmentPolicy(_provider: string | undefined): ProviderAttachmentPolicy {
  return supported;
}

/** Reject original attachments before canonical reference expansion or native mutations. */
export function providerAttachmentIssue(
  provider: string | undefined,
  attachments: ReadonlyArray<unknown> | undefined,
): string | undefined {
  return attachments?.length ? providerAttachmentPolicy(provider).unavailableReason : undefined;
}
