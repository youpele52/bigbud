import { observations, plan, type Observations, type Plan } from "./input.ts";

// Both sides have already been parsed into canonical field order.
function same(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function checkMetadata(expected: Plan, run: Observations) {
  const { identity } = expected.cell;
  const { metadata } = expected;
  if (
    metadata.schemaCeiling !== identity.schemaA ||
    metadata.migration !== identity.migration ||
    !same(run.a.artifact, identity.a) ||
    !same(run.b.artifact, identity.b) ||
    !same(run.a.metadata, metadata) ||
    !same(run.b.metadata, metadata)
  ) {
    throw new Error("A/B artifact or rollback schema/migration metadata mismatch");
  }
  for (const { db } of [run.before, run.drained, run.boundary, run.aOpen]) {
    if (db.domain !== identity.dbDomain || db.instance !== run.before.db.instance) {
      throw new Error("DB domain or instance changed across rollback");
    }
    if (!same(db.metadata, metadata)) throw new Error("Observed DB schema/migration mismatch");
  }
  const committed = run.drained.db.logicalSha256;
  if (run.boundary.db.logicalSha256 !== committed || run.aOpen.db.logicalSha256 !== committed) {
    throw new Error("Committed DB state changed between B drain and A first open");
  }
}

// B's storage revocation happens inside its drain: the owner shuts down and clears its
// attach record, then B commits its own retirement record before releasing the lock.
function checkDrain(expected: Plan, run: Observations) {
  const { drain } = run;
  if (!drain.owner.attachCleared) {
    throw new Error("B's owner did not clear its attach record during the drain");
  }
  if (
    drain.record.artifactSha256 !== expected.bRecordArtifactSha256 ||
    drain.record.ownerEpoch === null ||
    !same(drain.record.owner, drain.owner)
  ) {
    throw new Error("B's retirement record does not match B's artifact and owner shutdown");
  }
  if (drain.legacyMarkerSha256.before !== drain.legacyMarkerSha256.drained) {
    throw new Error("B's drain changed the legacy retirement marker");
  }
}

function checkProcesses(expected: Plan, run: Observations) {
  const inventory = new Map(expected.bInventory.map((entry) => [entry.component, entry]));
  const owners = expected.bInventory.filter((entry) => entry.role === "owner");
  if (
    inventory.size !== expected.bInventory.length ||
    owners.length !== 1 ||
    owners[0]?.imageSha256 !== expected.cell.identity.owner.image.sha256 ||
    !expected.bInventory.some((entry) => entry.role === "launcher")
  ) {
    throw new Error("Expected a unique B inventory with a launcher and the bound owner image");
  }
  const instances = new Set<string>();
  const holderIds = new Set(run.before.db.holders);
  const { before, drain, drained, boundary, aStart, aOpen } = run;
  const drainedHolders = new Set(drained.db.holders);
  if (
    !(
      before.seq < drain.seq &&
      drain.seq < drained.seq &&
      drained.seq < boundary.seq &&
      boundary.seq < aStart.seq &&
      aStart.seq < aOpen.seq
    )
  ) {
    throw new Error("Drain, committed record, offline boundary, and A startup are out of order");
  }
  const occupiedSequences = new Set([drain.seq, drained.seq]);
  for (const retirement of run.retirements) {
    const entry = inventory.get(retirement.component);
    if (
      !entry ||
      instances.has(retirement.before.instance) ||
      entry.imageSha256 !== retirement.before.imageSha256 ||
      !same(retirement.before, retirement.exit) ||
      occupiedSequences.has(retirement.seq) ||
      retirement.seq <= before.seq ||
      (drainedHolders.has(retirement.before.instance) && retirement.seq <= drained.seq) ||
      retirement.seq >= boundary.seq
    ) {
      throw new Error("Unexpected, duplicate, mismatched, or late B process exit");
    }
    inventory.delete(retirement.component);
    instances.add(retirement.before.instance);
    occupiedSequences.add(retirement.seq);
  }
  if (inventory.size) throw new Error("Missing B retirement coverage");
  if (
    !holderIds.size ||
    holderIds.size !== before.db.holders.length ||
    drainedHolders.size !== drained.db.holders.length ||
    [...holderIds, ...drainedHolders].some((id) => !instances.has(id)) ||
    boundary.db.holders.length !== 0
  ) {
    throw new Error("Expected known B DB holders and zero holders at the boundary");
  }
  const a = aStart.process;
  if (a.imageSha256 !== expected.aImageSha256 || instances.has(a.instance)) {
    throw new Error(
      "A startup process does not match the bound rollback image or reuses B identity",
    );
  }
  if (!same(aOpen.db.holders, [a.instance])) {
    throw new Error("A first-open DB holder is not exactly the verified A process");
  }
  checkLock(expected, run, instances);
}

// The fence is B's state-dir lock, then B's committed record, then A's lock: the lock
// may be free only after B's drain answered, and only B's launcher or A may hold it.
function checkLock(expected: Plan, run: Observations, instances: ReadonlySet<string>) {
  const { before, drain, drained, boundary, aOpen } = run;
  const holder = before.lock;
  const launchers = new Set(
    expected.bInventory.filter(({ role }) => role === "launcher").map(({ component }) => component),
  );
  const lockRetirement = run.retirements.find(({ before: process }) => process.instance === holder);
  if (
    holder === null ||
    !lockRetirement ||
    !launchers.has(lockRetirement.component) ||
    lockRetirement.seq <= drain.seq ||
    (drained.lock !== null && (drained.lock !== holder || lockRetirement.seq <= drained.seq)) ||
    boundary.lock !== null ||
    aOpen.lock !== run.aStart.process.instance ||
    instances.has(aOpen.lock)
  ) {
    throw new Error("State-dir lock was not held by B's launcher until its drain, then by A");
  }
}

export function validateRollbackBoundary(planInput: unknown, observationsInput: unknown) {
  const expected = plan(planInput);
  const run = observations(observationsInput);
  if (!same(expected.cell, run.cell)) throw new Error("Mismatched rollback matrix cell binding");
  checkMetadata(expected, run);
  checkDrain(expected, run);
  checkProcesses(expected, run);
  return { expected, run };
}

export function checkRollbackBoundary(planInput: unknown, observationsInput: unknown) {
  const { expected, run } = validateRollbackBoundary(planInput, observationsInput);
  return {
    status: "rollback-boundary-conforms",
    slot: expected.cell.slot.id,
    cell: expected.cell.cell,
    retiredProcesses: run.retirements.length,
    observationsAuthenticated: false,
    rollbackQualified: false,
    s4Accepted: false,
  } as const;
}
