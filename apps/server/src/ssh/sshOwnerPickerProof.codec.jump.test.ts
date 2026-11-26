import { expect, it } from "vitest";

import { WireWriter } from "../remote-agent/remoteAgentProtocol.codec.wire.ts";
import { readOutcome } from "./sshOwnerPickerProof.codec.outcome.ts";

function errorWithJump(writeJump?: (jump: WireWriter) => void) {
  const error = new WireWriter();
  error.fieldUint(1, 7);
  if (writeJump) {
    const jump = new WireWriter();
    writeJump(jump);
    error.fieldRepeatedMessage(2, jump.finish());
  }
  return readOutcome(10, error.finish());
}

it("preserves legacy errors and decodes a redacted jump leg and stage", () => {
  expect(errorWithJump()).toEqual({ kind: "error", code: "hostKeyChanged" });
  expect(
    errorWithJump((jump) => {
      jump.fieldUint(1, 2);
      jump.fieldUint(2, 3);
    }),
  ).toEqual({ kind: "error", code: "hostKeyChanged", jumpFailure: { leg: 2, stage: "handshake" } });
  expect(errorWithJump((jump) => jump.fieldUint(2, 1))).toMatchObject({
    jumpFailure: { leg: 0, stage: "admission" },
  });
});

it.each([
  [6, 1],
  [1, 0],
  [1, 6],
])("rejects out-of-range jump details (%i, %i)", (leg, stage) => {
  expect(() =>
    errorWithJump((jump) => {
      jump.fieldUint(1, leg);
      jump.fieldUint(2, stage);
    }),
  ).toThrow();
});
