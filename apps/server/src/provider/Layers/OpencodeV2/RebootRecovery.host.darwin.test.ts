import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { decodeV2DarwinRecoveryHost } from "./RebootRecovery.host.darwin.ts";

it("preserves the existing signed macOS checkpoint representation and host hash", () => {
  const uuid = "12345678-1234-1234-1234-123456789abc";
  const result = decodeV2DarwinRecoveryHost(
    `"IOPlatformUUID" = "${uuid.toUpperCase()}"`,
    `${uuid}\n`,
    "{ sec = 100, usec = 317063 }",
  );
  expect(JSON.stringify(result)).toBe(
    JSON.stringify({
      host: createHash("sha256").update(`bigbud.recovery.host.v1:${uuid}`).digest("hex"),
      bootSession: uuid,
      bootSeconds: 100,
      bootMicroseconds: 317063,
    }),
  );
  expect(() =>
    decodeV2DarwinRecoveryHost(
      `"IOPlatformUUID" = "${uuid}"`,
      uuid,
      "{ sec = 100, usec = 1000000 }",
    ),
  ).toThrow();
  expect(() =>
    decodeV2DarwinRecoveryHost(
      `"IOPlatformUUID" = "${uuid}"`,
      "-".repeat(36),
      "{ sec = 100, usec = 0 }",
    ),
  ).toThrow();
});
