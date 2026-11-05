/** Graphics capability queries do not create image state; actual graphics payloads remain refused. */
export function hasRecoveryImageState(completeControls: string): boolean {
  // oxlint-disable-next-line no-control-regex -- Match VT control delimiters, not printable text.
  if (/\x1bP[0-9;?]*q|\x1b\]1337;(?!Capabilities(?:\x07|\x1b\\))/.test(completeControls))
    return true;
  // oxlint-disable-next-line no-control-regex -- Completed APC commands have ESC/ST delimiters.
  for (const match of completeControls.matchAll(/\x1b_G([^;\x1b]*)(?:;|\x1b\\)/g)) {
    if (!/(?:^|,)a=q(?:,|$)/.test(match[1] ?? "")) return true;
  }
  return false;
}

export function hasPendingRecoveryImageCommand(tail: string): boolean {
  // oxlint-disable-next-line no-control-regex -- Partial VT introducers remain parser state.
  return /^\x1b_G|^\x1bP[0-9;?]*q|^\x1b\]1337;/.test(tail);
}
