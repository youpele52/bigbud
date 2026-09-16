interface OpencodeTextPart {
  live: string;
  emitted: string;
  snapshotOnly: boolean;
}

function extend(part: OpencodeTextPart, text: string) {
  // Stale or inconsistent snapshots cannot be appended to an existing prefix.
  if (!text.startsWith(part.emitted)) return "";
  const delta = text.slice(part.emitted.length);
  part.emitted = text;
  return delta;
}

/** One turn's text, shared by SSE delivery and cumulative message polling. */
export function makeOpencodeTextStream() {
  const parts = new Map<string, OpencodeTextPart>();
  let liveInvalidated = false;
  const getPart = (id: string) => {
    let part = parts.get(id);
    if (!part) {
      part = { live: "", emitted: "", snapshotOnly: false };
      parts.set(id, part);
    }
    return part;
  };
  return {
    delta(id: string, delta: string) {
      const part = getPart(id);
      if (liveInvalidated || part.snapshotOnly) return "";
      part.live += delta;
      return extend(part, part.live);
    },
    snapshot(id: string, text: string) {
      const part = getPart(id);
      // Once polling gets ahead, queued live deltas have no reliable offset.
      // Continue this part through cumulative snapshots, including its final text.
      if (text.length > part.live.length) part.snapshotOnly = true;
      return extend(part, text);
    },
    invalidateLive() {
      // A disconnected stream may have missed fragments, even for unseen parts.
      liveInvalidated = true;
    },
  };
}

export type OpencodeTextStream = ReturnType<typeof makeOpencodeTextStream>;
