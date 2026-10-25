export const OBSERVABLE_ESTIMATOR_VERSION = "observable-text-v1";

/** Rough unofficial estimate of observable text, not provider or billing tokenization. */
export function estimateObservableTokens(text: string): number {
  let codepoints = 0;
  for (const _codepoint of text) codepoints += 1;
  return Math.ceil(codepoints / 4);
}
