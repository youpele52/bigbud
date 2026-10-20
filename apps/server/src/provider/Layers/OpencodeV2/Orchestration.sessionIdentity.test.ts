import { randomBytes } from "node:crypto";
import { expect, it } from "vitest";
import {
  v2CompactNativeSessionId,
  isV2CompactNativeSessionId,
} from "./Orchestration.sessionIdentity.ts";

it("compact IDs are deterministic, lossless full-entropy encodings with a versioned 95-character bound", () => {
  for (let index = 0; index < 100; index++) {
    const issuer = randomBytes(32).toString("hex"),
      digest = randomBytes(32).toString("hex");
    const id = v2CompactNativeSessionId(issuer, digest);
    expect(id).toHaveLength(95);
    expect(id).toBe(v2CompactNativeSessionId(issuer, digest));
    expect(id.startsWith("ses_bb3_")).toBe(true);
    expect(Buffer.from(id.slice(8, 51), "base64url").toString("hex")).toBe(issuer);
    expect(Buffer.from(id.slice(52), "base64url").toString("hex")).toBe(digest);
    expect(isV2CompactNativeSessionId(id, issuer)).toBe(true);
    expect(isV2CompactNativeSessionId(id, randomBytes(32).toString("hex"))).toBe(false);
  }
});
