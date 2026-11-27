import { observations, plan, type Observations, type Plan } from "./input.ts";

// Parsers normalize field order before comparison.
function same(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function checkStorage(expected: Plan, run: Observations) {
  const { identity } = expected.cell;
  const { metadata } = expected;
  const { before, boundary, takeover, admission } = run;
  if (
    metadata.schemaCeiling !== identity.schemaA ||
    metadata.migration !== identity.migration ||
    !same(run.a.artifact, identity.a) ||
    !same(run.b.artifact, identity.b) ||
    !same(run.a.metadata, metadata) ||
    !same(run.b.metadata, metadata)
  ) {
    throw new Error("A/B artifact or forward schema/migration metadata mismatch");
  }
  for (const { db } of [before, boundary.snapshot, takeover.snapshot]) {
    if (db.domain !== identity.dbDomain || db.instance !== expected.dbInstance) {
      throw new Error("DB domain or instance changed across forward handoff");
    }
    if (!same(db.metadata, metadata)) throw new Error("Observed DB schema/migration mismatch");
  }
  if (admission.dbInstance !== expected.dbInstance) {
    throw new Error("B admission is not bound to the database");
  }
  // A's drain commits its marker before releasing the lock; B admits only on that marker.
  const { marker } = run;
  if (
    marker.artifactSha256 !== expected.aMarkerArtifactSha256 ||
    admission.markerSha256 !== marker.sha256 ||
    !(before.seq < marker.seq && marker.seq < boundary.snapshot.seq)
  ) {
    throw new Error("B admission is not bound to A's committed retirement marker");
  }
  const committed = boundary.snapshot.db.logicalSha256;
  if (
    takeover.snapshot.db.logicalSha256 !== committed ||
    takeover.hydratedLogicalSha256 !== committed
  ) {
    throw new Error("B takeover did not preserve and hydrate committed disconnect state");
  }
  if (
    takeover.previousEpoch !== boundary.writerEpoch ||
    takeover.writerEpoch === boundary.writerEpoch ||
    admission.writerEpoch !== takeover.writerEpoch
  ) {
    throw new Error(
      "B admission requires rotation from the observed prior writer epoch to a new epoch",
    );
  }
}

function checkProcesses(expected: Plan, run: Observations) {
  const { before, boundary, bStart, takeover, admission } = run;
  if (
    !(
      before.seq < boundary.snapshot.seq &&
      boundary.snapshot.seq < bStart.seq &&
      bStart.seq < takeover.snapshot.seq &&
      takeover.snapshot.seq < admission.seq
    )
  ) {
    throw new Error("Offline boundary, B startup, writer takeover, and admission are out of order");
  }

  const inventory = new Map(expected.aInventory.map((entry) => [entry.component, entry]));
  const instances = new Set(expected.aInventory.map(({ process }) => process.instance));
  const expectedHolders = expected.aInventory
    .filter((entry) => entry.dbHolder)
    .map(({ process }) => process.instance);
  if (
    inventory.size !== expected.aInventory.length ||
    instances.size !== inventory.size ||
    !expectedHolders.length ||
    !expected.aInventory.some((entry) => entry.role === "launcher")
  ) {
    throw new Error("Expected a unique A process inventory with a launcher and DB holder");
  }
  const sequences = new Set<number>();
  for (const { component, exit, seq } of run.retirements) {
    const entry = inventory.get(component);
    if (
      !entry ||
      !same(entry.process, exit) ||
      sequences.has(seq) ||
      seq <= before.seq ||
      seq === run.marker.seq ||
      seq >= boundary.snapshot.seq
    ) {
      throw new Error("Unexpected, duplicate, mismatched, or late A process exit");
    }
    inventory.delete(component);
    sequences.add(seq);
  }
  if (inventory.size) throw new Error("Missing A retirement coverage");
  if (
    !same(before.db.holders.toSorted(), expectedHolders.toSorted()) ||
    boundary.snapshot.db.holders.length !== 0
  ) {
    throw new Error("Expected exact frozen A DB holders and zero holders at the offline boundary");
  }

  const writer = bStart.process;
  const { owner } = admission;
  const ownerImage = expected.cell.identity.owner.image.sha256;
  if (
    writer.imageSha256 !== expected.bWriterImageSha256 ||
    writer.imageSha256 === ownerImage ||
    instances.has(writer.instance)
  ) {
    throw new Error("B writer does not match the bound backend image or reuses an A instance");
  }
  if (!same(takeover.snapshot.db.holders, [writer.instance])) {
    throw new Error("B takeover DB holder is not exactly the verified B writer");
  }
  if (
    owner.imageSha256 !== ownerImage ||
    owner.instance === writer.instance ||
    instances.has(owner.instance)
  ) {
    throw new Error(
      "B admission owner does not match the matrix owner image or reuses a process instance",
    );
  }
  // The fence is A's state-dir lock, A's committed marker, then B's lock: the lock is free
  // only between A's exit and B's start, and only A's launcher or the B writer holds it.
  const lockHolder = expected.aInventory.find(
    ({ role, process }) => role === "launcher" && process.instance === before.lock,
  );
  const lockExit = run.retirements.find(({ exit }) => exit.instance === before.lock);
  if (
    !lockHolder ||
    !lockExit ||
    lockExit.seq <= run.marker.seq ||
    boundary.snapshot.lock !== null ||
    takeover.snapshot.lock !== writer.instance ||
    admission.lock !== writer.instance
  ) {
    throw new Error("State-dir lock was not held by A's launcher, then by the B writer");
  }
}

function checkRelaunches(expected: Plan, run: Observations) {
  const entries = new Map(expected.legacyEntries.map((entry) => [entry.id, entry]));
  const launcherComponents = new Set(expected.legacyEntries.map((entry) => entry.component));
  if (
    entries.size !== expected.legacyEntries.length ||
    expected.aInventory.some(
      ({ component, role }) => launcherComponents.has(component) !== (role === "launcher"),
    )
  ) {
    throw new Error("Expected unique frozen legacy entries covering every observed A launcher");
  }

  const retired = new Set(expected.aInventory.map(({ process }) => process.instance));
  const attempts = new Set<string>();
  const sequences = new Set<number>();
  for (const { request, result } of run.relaunches) {
    const entry = entries.get(request.entry);
    if (
      !entry ||
      request.attempt !== result.attempt ||
      attempts.has(request.attempt) ||
      request.caller.imageSha256 !== entry.callerImageSha256 ||
      retired.has(request.caller.instance)
    ) {
      throw new Error(`${request.entry}: unexpected, duplicate, or mismatched legacy attempt`);
    }
    if (
      request.dbInstance !== expected.dbInstance ||
      result.dbInstance !== request.dbInstance ||
      result.lock !== run.admission.lock
    ) {
      throw new Error(`${request.entry}: legacy refusal is not bound to B's held lock and DB`);
    }
    if (
      request.seq <= run.admission.seq ||
      result.seq <= request.seq ||
      result.seq >= run.captureEnd ||
      sequences.has(request.seq) ||
      sequences.has(result.seq)
    ) {
      throw new Error(
        `${request.entry}: invalid legacy attempt ordering in post-admission capture`,
      );
    }
    entries.delete(request.entry);
    attempts.add(request.attempt);
    sequences.add(request.seq);
    sequences.add(result.seq);
  }
  if (entries.size)
    throw new Error(`Missing legacy relaunch observations: ${[...entries.keys()].join(", ")}`);
}

export function validateForwardBoundary(planInput: unknown, observationsInput: unknown) {
  const expected = plan(planInput);
  const run = observations(observationsInput);
  if (!same(expected.cell, run.cell) || expected.profileInstance !== run.profileInstance) {
    throw new Error("Mismatched forward matrix cell or profile instance binding");
  }
  checkStorage(expected, run);
  checkProcesses(expected, run);
  checkRelaunches(expected, run);
  return { expected, run };
}

export function checkForwardBoundary(planInput: unknown, observationsInput: unknown) {
  const { expected, run } = validateForwardBoundary(planInput, observationsInput);
  return {
    status: "forward-boundary-observations-conform",
    slot: expected.cell.slot.id,
    cell: expected.cell.cell,
    retiredProcesses: run.retirements.length,
    observedRelaunchRefusals: run.relaunches.length,
  } as const;
}
