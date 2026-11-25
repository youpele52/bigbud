import { message } from "./sshOwnerPickerProof.codec.wire.ts";

export const encodeStorageSnapshot = (
  targetId: string,
  snapshot:
    | { readonly writerEpoch: string; readonly seq: number; readonly disconnected: boolean }
    | undefined,
) =>
  message(8, (writer) => {
    writer.fieldString(1, targetId);
    if (snapshot) {
      writer.fieldString(2, snapshot.writerEpoch);
      writer.fieldUint(3, snapshot.seq);
      writer.fieldBool(4, snapshot.disconnected);
    } else writer.fieldUint(5, 13);
  });

export const encodeStorageResult = (requestId: Uint8Array, committedSeq: number | undefined) =>
  message(10, (writer) => {
    writer.fieldBytes(1, requestId);
    if (committedSeq !== undefined) {
      writer.fieldUint(2, committedSeq);
      writer.fieldBool(3, true);
    } else writer.fieldUint(4, 13);
  });
