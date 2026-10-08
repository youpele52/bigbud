/** Original native settlement is separate from an outer transport deadline/abort. */
export interface V2MutationObservation {
  pending: number;
  unconfirmed: boolean;
}

export function observeV2Mutation(
  record: V2MutationObservation,
  operation: Promise<unknown>,
  settled: () => void,
) {
  record.pending++;
  void operation.then(
    () => {
      record.pending--;
      settled();
    },
    () => {
      record.pending--;
      // Rejection may be a transport abort while the native mutation continues.
      record.unconfirmed = true;
      settled();
    },
  );
}
