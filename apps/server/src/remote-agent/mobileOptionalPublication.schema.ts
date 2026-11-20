import { Schema } from "effect";

const IdentityNumber = Schema.String.check(Schema.isPattern(/^[0-9]{1,32}$/));
export const MobilePublicationDirectoryIdentity = Schema.Struct({
  dev: IdentityNumber,
  ino: IdentityNumber,
});
export const MobilePublicationIntent = Schema.Struct({
  key: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  root: MobilePublicationDirectoryIdentity,
  namespace: MobilePublicationDirectoryIdentity,
  directory: MobilePublicationDirectoryIdentity,
});
export type MobilePublicationIntent = typeof MobilePublicationIntent.Type;
export const MobilePublicationFileIdentity = Schema.Struct({
  dev: IdentityNumber,
  ino: IdentityNumber,
  mtimeNs: IdentityNumber,
  ctimeNs: IdentityNumber,
});
export const MobilePublicationReceipt = Schema.Struct({
  directoryMtimeNs: IdentityNumber,
  directoryCtimeNs: IdentityNumber,
  gateway: MobilePublicationFileIdentity,
  assets: MobilePublicationFileIdentity,
});
export type MobilePublicationReceipt = typeof MobilePublicationReceipt.Type;
