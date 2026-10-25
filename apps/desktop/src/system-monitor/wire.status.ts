import type { MonitorCollectionStatus } from "@bigbud/contracts/system-monitor/types";
import { fields, requireKind } from "./wire.reader";

export function decodeCollectionStatus(bytes: Uint8Array): MonitorCollectionStatus {
  let phase = 0;
  const status: MonitorCollectionStatus = {
    state: "healthy",
    attempts: 0,
    retryAfterMs: 0,
    reason: "",
    epoch: 0,
  };
  fields(bytes, (field, kind, reader) => {
    if ([1, 2, 3, 5].includes(field)) {
      requireKind(kind, 0);
      const value = reader.uint();
      if (field === 1) phase = value;
      else if (field === 2) status.attempts = value;
      else if (field === 3) status.retryAfterMs = value;
      else status.epoch = value;
    } else if (field === 4) {
      requireKind(kind, 2);
      status.reason = reader.string();
    } else reader.skip(kind);
  });
  if (phase === 1) status.state = "healthy";
  else if (phase === 2) status.state = "retrying";
  else if (phase === 3) status.state = "failed";
  else throw new Error("invalid collection phase");
  if (status.epoch < 1 || status.attempts > 3 || status.retryAfterMs > 60_000)
    throw new Error("invalid collection status");
  return status;
}
