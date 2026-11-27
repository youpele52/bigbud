import { WireWriter } from "../remote-agent/remoteAgentProtocol.codec.wire.ts";
import { writeHelloFields } from "./sshOwnerPickerProof.codec.ts";
import { message } from "./sshOwnerPickerProof.codec.wire.ts";

/**
 * Attachment-socket handshake frames (ProofAttachProbe 11, ProofAttachHello 13).
 * The probe may name the 32-byte artifact identity this backend would launch
 * (v1.owner_shutdown.proto); a production owner refuses another identity.
 *
 * @module sshOwnerPickerProof.codec.attach
 */
export const encodeAttachProbe = (clientNonce: Uint8Array, expectedIdentity?: Uint8Array) =>
  message(11, (writer) => {
    writer.fieldBytes(1, clientNonce);
    if (expectedIdentity !== undefined && expectedIdentity.length > 0)
      writer.fieldBytes(2, expectedIdentity);
  });

export const encodeAttachHello = (profileBinding: Uint8Array, major: number, proof: Uint8Array) =>
  message(13, (writer) => {
    const hello = new WireWriter();
    writeHelloFields(hello, profileBinding, major);
    writer.fieldRepeatedMessage(1, hello.finish());
    writer.fieldBytes(2, proof);
  });
