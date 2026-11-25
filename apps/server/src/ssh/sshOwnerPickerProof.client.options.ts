import type { PickerProofSessionOptions } from "./sshOwnerPickerProof.client.session.ts";
import { OWNER_MAJOR, PickerProofOwnerError } from "./sshOwnerPickerProof.codec.ts";

export function copyPickerProofSessionOptions({
  profileBinding,
  targetId,
  sql,
  major = OWNER_MAJOR,
}: PickerProofSessionOptions) {
  if (
    !Number.isInteger(major) ||
    major < 0 ||
    major > 0xffff_ffff ||
    profileBinding.length === 0 ||
    profileBinding.length > 128 ||
    (targetId !== undefined && (!targetId || Buffer.byteLength(targetId) > 1_024))
  )
    throw new PickerProofOwnerError("invalidOperands");
  return {
    profileBinding: Buffer.from(profileBinding),
    ...(targetId === undefined ? {} : { targetId }),
    sql,
    major,
  };
}
