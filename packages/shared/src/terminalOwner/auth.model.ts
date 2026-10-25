import type {
  ChallengeFields,
  ClientHello,
  ClientProof,
  FinishAck,
} from "@bigbud/contracts/terminal-owner/auth";
import { encodeCanonical } from "./canonical";
import {
  validateAuthBinding,
  transcriptDigest,
  transcriptProof,
  finishFields,
  ownerFinish,
  finishAck,
  verifyTag,
  type AuthExpectations,
} from "./auth";
import { equalBytes } from "./canonical.validation";
import { requireContract } from "./errors";

export type AuthState = "challenged" | "finishPending" | "ready" | "closed";
/** Pure receiver-clock handshake model. Credential store and promotion are explicit owned callbacks. */
export class OwnerAuthExchange {
  private stateValue: AuthState = "challenged";
  private readonly hello: ClientHello;
  private readonly fields: ChallengeFields;
  private readonly key: Uint8Array;
  private readonly transcript: Uint8Array;
  private lastNow: number;
  constructor(
    hello: ClientHello,
    fields: ChallengeFields,
    key: Uint8Array,
    expected: AuthExpectations,
    private readonly acceptedAtMs: number,
  ) {
    requireContract(
      Number.isSafeInteger(acceptedAtMs) && acceptedAtMs >= 0 && key.length === 32,
      "AUTH_FAILED",
    );
    validateAuthBinding(hello, fields, expected);
    requireContract(
      encodeCanonical("ClientHello", hello).length <= 8192 &&
        encodeCanonical("ChallengeFields", fields).length + 32 <= 8192,
      "AUTH_CAPACITY",
    );
    this.hello = structuredClone(hello);
    this.fields = structuredClone(fields);
    this.key = key.slice();
    this.transcript = transcriptDigest(this.hello, this.fields);
    this.lastNow = acceptedAtMs;
  }
  get state(): AuthState {
    return this.stateValue;
  }
  challenge() {
    requireContract(this.stateValue === "challenged", "AUTH_STATE");
    return {
      fields: structuredClone(this.fields),
      ownerProof: transcriptProof(this.key, "owner-proof", this.transcript),
    };
  }
  private deadline(nowMs: number) {
    requireContract(Number.isSafeInteger(nowMs) && nowMs >= this.lastNow, "CLOCK_INVALID");
    this.lastNow = nowMs;
    if (nowMs - this.acceptedAtMs >= Number(this.fields.ttlRemainingMs)) {
      this.close();
      requireContract(false, "AUTH_EXPIRED");
    }
  }
  prove(
    proof: ClientProof,
    nowMs: number,
    consumeCredential: () => void,
    recheckFences: () => void,
  ) {
    this.deadline(nowMs);
    requireContract(this.stateValue === "challenged", "AUTH_STATE");
    encodeCanonical("ClientProof", proof);
    requireContract(
      equalBytes(proof.handshakeId, this.fields.handshakeId) &&
        equalBytes(proof.transcript, this.transcript) &&
        verifyTag(transcriptProof(this.key, "client-proof", this.transcript), proof.clientProof),
      "AUTH_FAILED",
    );
    recheckFences();
    if (this.hello.kind !== 1) consumeCredential();
    this.stateValue = "finishPending";
    return ownerFinish(this.key, finishFields(this.fields, this.transcript));
  }
  acknowledge(ack: FinishAck, nowMs: number, recheckFences: () => void) {
    this.deadline(nowMs);
    requireContract(this.stateValue === "finishPending", "AUTH_STATE");
    encodeCanonical("FinishAck", ack);
    const expected = finishAck(
      this.key,
      ownerFinish(this.key, finishFields(this.fields, this.transcript)),
    );
    requireContract(
      equalBytes(ack.handshakeId, expected.handshakeId) &&
        equalBytes(ack.sessionId, expected.sessionId) &&
        equalBytes(ack.finishDigest, expected.finishDigest) &&
        verifyTag(expected.ackProof, ack.ackProof),
      "AUTH_FAILED",
    );
    recheckFences();
    this.stateValue = "ready";
    const disposition =
      this.hello.kind === 1
        ? this.hello.rootIntent!.mode === 5
          ? 2
          : 1
        : this.hello.kind === 4
          ? 5
          : this.hello.kind === 3 || this.fields.scope!.use === 2
            ? 4
            : 3;
    return {
      sessionId: this.fields.proposedSession.slice(),
      transcript: this.transcript.slice(),
      authorityRevision: this.fields.authorityRevision,
      disposition,
    } as const;
  }
  close() {
    this.stateValue = "closed";
    this.key.fill(0);
  }
}
