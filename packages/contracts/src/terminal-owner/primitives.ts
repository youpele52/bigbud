import { Schema } from "effect";

/** v1 canonical operands. Decimal cursors are never coerced through JS numbers. */
export const U64 = Schema.String.check(
  Schema.makeFilter((s) => /^(0|[1-9][0-9]{0,19})$/.test(s) && BigInt(s) <= 18446744073709551615n),
);
export const U32 = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 4294967295 }));
export const Version = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 65535 }));
export const Bytes = Schema.Uint8Array.check(Schema.makeFilter((b) => b.length <= 49152));
export const Id = Schema.Uint8Array.check(Schema.makeFilter((b) => b.length === 32));
export const IssuedId = Id.check(Schema.makeFilter((b) => b.some((v) => v !== 0)));
export const Role = Schema.Literals([1, 2, 3, 4]);
export const Lane = Schema.Literals([1, 2, 3, 4]);
export const AuthKind = Schema.Literals([1, 2, 3, 4]);
export const RootMode = Schema.Literals([1, 2, 3, 4, 5]);
export const RootUse = Schema.Literals([1, 2, 3]);
export const OS = Schema.Literals([1, 2]);
export const GrantUse = Schema.Literals([1, 2, 3]);
export const Capability = Schema.Literals([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
export const Capabilities = Schema.Array(Capability).check(Schema.isMaxLength(10));
export type U64 = typeof U64.Type;
