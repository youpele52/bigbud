import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { WireWriter } from "../remote-agent/remoteAgentProtocol.codec.wire.ts";
import {
  readWorkspaceFile,
  verifyWorkspaceFile,
} from "./sshOwnerPickerProof.codec.workspaceFile.ts";

const data = Buffer.from("﻿café\r\n");
const digest = createHash("sha256").update(data).digest();

function reply(...digests: readonly Uint8Array[]) {
  const writer = new WireWriter();
  writer.fieldBytes(1, data);
  writer.fieldUint(2, data.byteLength);
  for (const value of digests) writer.fieldBytes(4, value);
  return writer.finish();
}

it("keeps legacy previews readable without a digest and exposes complete preview SHA-256", () => {
  const legacy = readWorkspaceFile(reply());
  expect(legacy.sha256).toBeUndefined();
  verifyWorkspaceFile({ kind: "preview" }, legacy);
  const preview = readWorkspaceFile(reply(digest));
  expect(preview.sha256).toBe(digest.toString("hex"));
  expect(Buffer.from(preview.data)).toEqual(data);
  verifyWorkspaceFile({ kind: "preview" }, preview);
  expect(() =>
    verifyWorkspaceFile({ kind: "range", offset: 0, maxBytes: data.length }, preview),
  ).toThrow();
});

it("rejects malformed or duplicate raw digests", () => {
  expect(() => readWorkspaceFile(reply(digest.subarray(1)))).toThrow();
  expect(() => readWorkspaceFile(reply(digest, digest))).toThrow();
});
