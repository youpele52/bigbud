import type {
  RemoteAgentServiceLeaseBinding,
  RemoteAgentServiceLeaseEnvironment,
  RemoteAgentServiceLeaseController,
} from "./remoteAgentProtocol.serviceLease.ts";
import { decodeMessage, requireWireType, WireWriter } from "./remoteAgentProtocol.codec.wire.ts";

export function encodeLeaseBinding(value: RemoteAgentServiceLeaseBinding): Uint8Array {
  const writer = new WireWriter();
  writer.fieldString(1, value.authority);
  writer.fieldString(2, value.installation);
  writer.fieldString(3, value.nativeEpoch);
  writer.fieldString(4, value.nonce);
  writer.fieldBytes(5, value.publicationSha256);
  writer.fieldBytes(6, value.executableSha256);
  writer.fieldBytes(7, value.assetsSha256);
  writer.fieldBytes(8, value.configurationSha256);
  writer.fieldBytes(9, value.guardSha256);
  return writer.finish();
}
export function decodeLeaseBinding(bytes: Uint8Array): RemoteAgentServiceLeaseBinding {
  const value: {
    -readonly [K in keyof RemoteAgentServiceLeaseBinding]: RemoteAgentServiceLeaseBinding[K];
  } = {
    authority: "",
    installation: "",
    nativeEpoch: "",
    nonce: "",
    publicationSha256: new Uint8Array(),
    executableSha256: new Uint8Array(),
    assetsSha256: new Uint8Array(),
    configurationSha256: new Uint8Array(),
    guardSha256: new Uint8Array(),
  };
  decodeMessage(bytes, (field, wire, reader) => {
    if (field < 1 || field > 9) {
      reader.skip(wire);
      return;
    }
    requireWireType(wire, 2);
    switch (field) {
      case 1:
        value.authority = reader.string();
        break;
      case 2:
        value.installation = reader.string();
        break;
      case 3:
        value.nativeEpoch = reader.string();
        break;
      case 4:
        value.nonce = reader.string();
        break;
      case 5:
        value.publicationSha256 = reader.bytesValue();
        break;
      case 6:
        value.executableSha256 = reader.bytesValue();
        break;
      case 7:
        value.assetsSha256 = reader.bytesValue();
        break;
      case 8:
        value.configurationSha256 = reader.bytesValue();
        break;
      case 9:
        value.guardSha256 = reader.bytesValue();
        break;
    }
  });
  return value;
}
export function encodeLeaseEnvironment(value: RemoteAgentServiceLeaseEnvironment): Uint8Array {
  const writer = new WireWriter();
  writer.fieldString(1, value.name);
  writer.fieldString(2, value.value);
  return writer.finish();
}
export function decodeLeaseEnvironment(bytes: Uint8Array): RemoteAgentServiceLeaseEnvironment {
  const value = { name: "", value: "" };
  decodeMessage(bytes, (field, wire, reader) => {
    if (field !== 1 && field !== 2) {
      reader.skip(wire);
      return;
    }
    requireWireType(wire, 2);
    if (field === 1) value.name = reader.string();
    else value.value = reader.string();
  });
  return value;
}
export function encodeLeaseController(value: RemoteAgentServiceLeaseController): Uint8Array {
  const writer = new WireWriter();
  writer.fieldUint(1, value.pid);
  writer.fieldString(2, value.boot);
  writer.fieldString(3, value.started);
  return writer.finish();
}
export function decodeLeaseController(bytes: Uint8Array): RemoteAgentServiceLeaseController {
  const value = { pid: 0, boot: "", started: "" };
  decodeMessage(bytes, (field, wire, reader) => {
    if (field === 1) {
      requireWireType(wire, 0);
      value.pid = reader.uint();
    } else if (field === 2 || field === 3) {
      requireWireType(wire, 2);
      if (field === 2) value.boot = reader.string();
      else value.started = reader.string();
    } else reader.skip(wire);
  });
  return value;
}
