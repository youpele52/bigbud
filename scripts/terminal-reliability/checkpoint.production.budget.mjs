// Same per-category ceilings as the older isolated experiment; not product configuration limits.
export const PRODUCTION_CHECKPOINT_BUDGET = Object.freeze({
  encodedBytes: 128 * 1024 * 1024,
  stagingBytes: 128 * 1024 * 1024,
  stateBytes: 128 * 1024 * 1024,
  aggregateBytes: 512 * 1024 * 1024,
});

/** Scan text before JSON.parse can allocate attacker-controlled arrays/objects. Estimates are conservative, not allocator instrumentation. */
export function scanCheckpointWire(text) {
  if (typeof text !== "string") throw new Error("checkpoint wire must be a string");
  const encodedBytes = text.length * 2;
  if (encodedBytes > PRODUCTION_CHECKPOINT_BUDGET.encodedBytes)
    throw new Error("checkpoint encoded budget exceeded");
  let decodedBytes = 0;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      const start = i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === "\\") i++;
        i++;
      }
      if (i >= text.length) throw new Error("unterminated checkpoint string");
      decodedBytes += (i - start) * 2 + 64;
    } else if (char === "[" || char === "{") {
      if (++depth > 32) throw new Error("checkpoint nesting limit exceeded");
      decodedBytes += 128;
    } else if (char === "]" || char === "}") depth--;
    else if (char !== ":" && char !== "," && !/\s/.test(char)) {
      decodedBytes += 32;
      while (i + 1 < text.length && !/[\s,\]}]/.test(text[i + 1])) i++;
    }
    if (encodedBytes + decodedBytes > PRODUCTION_CHECKPOINT_BUDGET.stagingBytes)
      throw new Error("checkpoint decode staging budget exceeded");
  }
  return { encodedBytes, decodedBytes };
}

/** Lower bounds suffice to refuse maximum state BEFORE creating numeric arrays or a wire string. */
export function estimateProductionCapture(terminal) {
  const buffers = [terminal._core.buffers.normal, terminal._core.buffers.alt];
  let words = 0;
  let stringBytes = 0;
  for (const buffer of buffers)
    for (let i = 0; i < buffer.lines.length; i++) {
      const line = buffer.lines.get(i);
      words += line._data.length;
      for (const value of Object.values(line._combined)) stringBytes += value.length * 2;
    }
  return {
    words,
    encodedLowerBound: words * 4 + stringBytes,
    decodedLowerBound: words * 8 + stringBytes,
    materializedCellBytes: words * 4,
    // Existing owned engine cells + projected numeric arrays + cloned projection + minimum wire.
    captureLowerBound: words * 24 + stringBytes * 3,
  };
}

export function admitProductionCapture(terminal) {
  const estimate = estimateProductionCapture(terminal);
  if (
    estimate.encodedLowerBound > PRODUCTION_CHECKPOINT_BUDGET.encodedBytes ||
    estimate.decodedLowerBound + estimate.encodedLowerBound + estimate.materializedCellBytes >
      PRODUCTION_CHECKPOINT_BUDGET.stagingBytes ||
    estimate.captureLowerBound > PRODUCTION_CHECKPOINT_BUDGET.aggregateBytes
  )
    throw new Error("checkpoint capture budget exceeded");
  return estimate;
}
