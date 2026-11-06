import { createHash } from "node:crypto";

import {
  ORGANIZATION_LIMITS,
  type OrganizationFrame,
  type OrganizationLimits,
  type OrganizationRow,
  type SnapshotBegin,
} from "./organizationProtocol.ts";
import { validateOrganizationLimits } from "./organizationProtocol.limits.ts";
import { encodeOrganizationFrame, encodeOrganizationRow } from "./organizationProtocol.encode.ts";

export function updateSnapshotDigest(
  hash: ReturnType<typeof createHash>,
  row: OrganizationRow,
): number {
  const bytes = encodeOrganizationRow(row);
  const prefix = new Uint8Array(4);
  new DataView(prefix.buffer).setUint32(0, bytes.length, false);
  hash.update(prefix).update(bytes);
  return bytes.length + 4;
}

// The caller must supply one transaction's compact rows and canonical frontier,
// captured after starting event capture. This does not read DB or schedule work.
// A throwing/incomplete iterator never produces an end frame, so cannot activate.
export function* encodeCompactSnapshot(
  epoch: { backendNonce: string; generation: number },
  begin: SnapshotBegin,
  rows: Iterable<OrganizationRow>,
  limits: OrganizationLimits = ORGANIZATION_LIMITS,
): Generator<OrganizationFrame> {
  validateOrganizationLimits(limits);
  const start: OrganizationFrame = { ...epoch, type: "begin", value: begin };
  encodeOrganizationFrame(start, limits);
  yield start;
  const hash = createHash("sha256");
  let page: OrganizationRow[] = [];
  let pageBytes = 0;
  let index = 0;
  let count = 0;
  let stateBytes = 0;
  let previous: Buffer | undefined;
  const pageFrame = (): OrganizationFrame => ({
    ...epoch,
    type: "page",
    value: { snapshotId: begin.snapshotId, index, rows: page },
  });
  for (const row of rows) {
    const id = Buffer.from(row.threadId, "utf8");
    if (id.length === 0 || id.length > 256 || (previous && Buffer.compare(previous, id) >= 0)) {
      throw new Error("compact snapshot rows must have unique ordered IDs");
    }
    previous = id;
    count += 1;
    const rowBytes = updateSnapshotDigest(hash, row);
    stateBytes += rowBytes;
    if (count > limits.liveRows || stateBytes > limits.stateBytes)
      throw new RangeError("compact snapshot exceeds capacity");
    // Conservative row tag/length overhead plus 1 KiB envelope budget, checked
    // exactly at each page boundary. No quadratic re-encoding while filling pages.
    const contribution = rowBytes + 6;
    if (page.length > 0 && pageBytes + contribution > limits.frameBytes - 1024) {
      encodeOrganizationFrame(pageFrame(), limits);
      yield pageFrame();
      index += 1;
      page = [];
      pageBytes = 0;
    }
    page.push(row);
    pageBytes += contribution;
    if (page.length === limits.pageRows) {
      encodeOrganizationFrame(pageFrame(), limits);
      yield pageFrame();
      index += 1;
      page = [];
      pageBytes = 0;
    }
  }
  if (page.length > 0) {
    encodeOrganizationFrame(pageFrame(), limits);
    yield pageFrame();
    index += 1;
  }
  const end: OrganizationFrame = {
    ...epoch,
    type: "end",
    value: {
      snapshotId: begin.snapshotId,
      pages: index,
      rows: count,
      digest: new Uint8Array(hash.digest()),
      policyVersion: begin.policy.version,
    },
  };
  encodeOrganizationFrame(end, limits);
  yield end;
}
