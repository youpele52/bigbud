import type { MonitorEvent } from "@bigbud/contracts/system-monitor/types";
import { fields, requireKind } from "./wire.reader";

export function decodeHelloAck(bytes: Uint8Array): Extract<MonitorEvent, { type: "helloAck" }> {
  const ack = {
    major: 0,
    minor: 0,
    maximumFrameBytes: 0,
    maximumSubscriptions: 0,
    epoch: 0,
    capabilities: [] as string[],
    hostname: undefined as string | undefined,
    osName: undefined as string | undefined,
    osVersion: undefined as string | undefined,
    architecture: undefined as string | undefined,
  };
  fields(bytes, (field, kind, reader) => {
    if (field === 6) {
      requireKind(kind, 2);
      ack.capabilities.push(reader.string());
    } else if (field >= 7 && field <= 10) {
      requireKind(kind, 2);
      const value = reader.string();
      if (field === 7) ack.hostname = value;
      else if (field === 8) ack.osName = value;
      else if (field === 9) ack.osVersion = value;
      else ack.architecture = value;
    } else if (field <= 5) {
      requireKind(kind, 0);
      const value = reader.uint();
      if (field === 1) ack.major = value;
      else if (field === 2) ack.minor = value;
      else if (field === 3) ack.maximumFrameBytes = value;
      else if (field === 4) ack.maximumSubscriptions = value;
      else ack.epoch = value;
    } else reader.skip(kind);
  });
  return {
    type: "helloAck",
    major: ack.major,
    minor: ack.minor,
    maximumFrameBytes: ack.maximumFrameBytes,
    maximumSubscriptions: ack.maximumSubscriptions,
    epoch: ack.epoch,
    capabilities: ack.capabilities,
    ...(ack.hostname === undefined ? {} : { hostname: ack.hostname }),
    ...(ack.osName === undefined ? {} : { osName: ack.osName }),
    ...(ack.osVersion === undefined ? {} : { osVersion: ack.osVersion }),
    ...(ack.architecture === undefined ? {} : { architecture: ack.architecture }),
  };
}
