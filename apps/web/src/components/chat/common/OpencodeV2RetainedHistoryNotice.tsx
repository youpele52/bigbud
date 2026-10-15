/** Retained canonical transcripts remain visible; this notice is not the dismissible provider-wide advisory. */
export function OpencodeV2RetainedHistoryNotice({ message }: { readonly message: string }) {
  return (
    <div
      role="status"
      className="border-b border-warning/30 bg-warning/5 px-4 py-3 text-sm text-warning"
    >
      {message}
    </div>
  );
}
