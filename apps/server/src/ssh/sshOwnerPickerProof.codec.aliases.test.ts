import { describe, expect, it } from "vitest";

import { readProofAliases } from "./sshOwnerPickerProof.codec.aliases.ts";
import { WireWriter } from "../remote-agent/remoteAgentProtocol.codec.wire.ts";

function entry(write: (writer: WireWriter) => void): Uint8Array {
  const writer = new WireWriter();
  write(writer);
  return writer.finish();
}

function aliases(
  entries: ReadonlyArray<Uint8Array>,
  maxEntries: number | null = 256,
  truncated?: boolean,
) {
  const writer = new WireWriter();
  for (const item of entries) writer.fieldRepeatedMessage(1, item);
  if (truncated !== undefined) writer.fieldBool(2, truncated);
  if (maxEntries !== null) writer.fieldUint(3, maxEntries);
  return writer.finish();
}

const direct = entry((writer) => {
  writer.fieldString(1, "build-box");
  writer.fieldString(2, "build.internal");
  writer.fieldUint(3, 2222);
  writer.fieldString(4, "ci");
  writer.fieldString(5, "build-trust");
  writer.fieldUint(6, 1);
  writer.fieldString(8, "user_config");
  writer.fieldUint(9, 5);
});

const unsupported = entry((writer) => {
  writer.fieldString(1, "blocked");
  writer.fieldString(2, "blocked.internal");
  writer.fieldUint(3, 22);
  writer.fieldUint(6, 3);
  writer.fieldUint(7, 1);
  writer.fieldString(8, "user_config");
  writer.fieldUint(9, 9);
  const reason = new WireWriter();
  reason.fieldString(1, "localcommand");
  reason.fieldString(2, "Remove the unsupported directive from this host.");
  reason.fieldString(3, "user_config");
  reason.fieldUint(4, 9);
  writer.fieldRepeatedMessage(10, reason.finish());
});

describe("readProofAliases", () => {
  it("reads bounded metadata, route facts and per-alias refusals", () => {
    const result = readProofAliases(aliases([direct, unsupported], 256, false));
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0]).toMatchObject({
      alias: "build-box",
      hostName: "build.internal",
      port: 2222,
      user: "ci",
      hostKeyAlias: "build-trust",
      routeKind: "direct",
      jumpHops: 0,
      source: "user_config",
      line: 5,
    });
    expect(result.entries[0]?.unsupported).toBeUndefined();
    expect(result.entries[1]).toMatchObject({
      alias: "blocked",
      routeKind: "jump",
      jumpHops: 1,
      unsupported: {
        reason: "localcommand",
        source: "user_config",
        line: 9,
      },
    });
    expect(result.truncated).toBe(false);
    expect(result.maxEntries).toBe(256);
  });

  it("defaults an absent truncated field to false but requires max_entries", () => {
    expect(readProofAliases(aliases([direct], 256)).truncated).toBe(false);
    expect(() => readProofAliases(aliases([direct], null))).toThrow();
  });

  it("rejects an over-bound alias count, entries beyond the bound or a jump without hops", () => {
    expect(() => readProofAliases(aliases([direct], 257))).toThrow();
    expect(() => readProofAliases(aliases([direct, unsupported], 1))).toThrow();
    const jumpWithoutHops = entry((writer) => {
      writer.fieldString(1, "jump");
      writer.fieldString(2, "jump.internal");
      writer.fieldUint(3, 22);
      writer.fieldUint(6, 3);
      writer.fieldString(8, "user_config");
      writer.fieldUint(9, 1);
    });
    expect(() => readProofAliases(aliases([jumpWithoutHops]))).toThrow();
  });
});
