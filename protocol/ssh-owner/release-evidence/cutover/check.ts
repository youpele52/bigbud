import { manifest, rows, traces, type Manifest, type Run } from "./evidence.ts";

type Launch = { image: string; seq: number; ownerControlled: boolean };

function inspect(run: Run, plan: Manifest): Launch[] {
  const sshDigests = new Set(plan.sshSha256);
  const images = new Map<
    string,
    { seq: number; instance: string; inherited: boolean; owner: boolean }
  >();
  const current = new Map<string, string>();
  const launches: Launch[] = [];
  let root = false;
  let seq = 0;

  for (const image of run.images) {
    if (image.seq <= seq || image.seq === run.begin || image.seq === run.end) {
      throw new Error(`${run.id}: invalid recorder event order`);
    }
    seq = image.seq;
    const from = image.from === null ? undefined : images.get(image.from);
    if (images.has(image.id)) throw new Error(`${run.id}: repeated image ID`);
    if (image.via === "root") {
      if (root || image.from !== null) throw new Error(`${run.id}: invalid trace root`);
      root = true;
    } else if (!from || current.get(from.instance) !== image.from) {
      throw new Error(`${run.id}: missing or stale process ancestry`);
    }
    if (image.via === "exec" ? from?.instance !== image.instance : current.has(image.instance)) {
      throw new Error(`${run.id}: inconsistent process instance`);
    }

    // An exec replacing the verified owner itself does not inherit its authority.
    const inherited = !!(from && (from.inherited || (image.via === "spawn" && from.owner)));
    const owner = image.id === run.owner;
    if (
      owner !== (image.sha256 === plan.ownerSha256) ||
      (owner && (run.side === "A" || image.via === "root" || inherited))
    ) {
      throw new Error(`${run.id}: unexpected or unverified owner identity`);
    }
    images.set(image.id, { seq, instance: image.instance, inherited, owner });
    current.set(image.instance, image.id);

    const basename = image.basename.toLowerCase();
    if (/^(ssh|ssh-keyscan)(\.exe)?$/.test(basename) || sshDigests.has(image.sha256)) {
      if (owner || image.via === "root") throw new Error(`${run.id}: invalid transport lineage`);
      launches.push({ image: image.id, seq, ownerControlled: inherited });
    }
  }

  const actor = images.get(run.actor);
  if (
    !actor ||
    actor.seq >= run.begin ||
    run.begin >= run.end ||
    launches.some((launch) => launch.image === run.actor) ||
    (run.owner !== null && !images.has(run.owner))
  ) {
    throw new Error(`${run.id}: missing action actor or owner image`);
  }
  return launches;
}

export function checkCutover(planInput: unknown, traceInput: unknown) {
  const plan = manifest(planInput);
  if (
    plan.a.id === plan.b.id ||
    plan.a.sha256 === plan.b.sha256 ||
    plan.sshSha256.includes(plan.ownerSha256)
  ) {
    throw new Error("Expected distinct A/B artifact identities and a distinct owner image");
  }
  const cases = new Map(plan.cases.map((item) => [item.id, item]));
  if (
    cases.size !== plan.cases.length ||
    rows.some((row) => !plan.cases.some((c) => c.row === row))
  ) {
    throw new Error("Expected unique cases covering X1-X4 and G1-G3");
  }
  for (const row of ["X1", "X2", "X3"]) {
    if (
      !plan.cases.some(
        (c) => c.row === row && c.aMode === "legacy-baseline" && c.bMode === "zero-ssh",
      )
    ) {
      throw new Error(`${row}: missing legacy-entry negative case`);
    }
  }
  for (const c of plan.cases) {
    if (
      (c.row === "X4" && c.aMode !== "intentional-denial") ||
      (c.aMode === "intentional-denial" && c.bMode !== "zero-ssh")
    ) {
      throw new Error(`${c.id}: intentional denials must forbid launches on both builds`);
    }
  }
  if (!plan.cases.some((c) => c.bMode === "owner-only")) {
    throw new Error("Expected a positive B owner control");
  }

  const runIds = new Set<string>();
  const paired = new Set<string>();
  const results = [];
  for (const run of traces(traceInput)) {
    const c = cases.get(run.caseId);
    const key = `${run.side}:${run.caseId}`;
    if (!c || runIds.has(run.id) || paired.has(key)) {
      throw new Error(`${run.id}: unknown case or duplicate trace`);
    }
    runIds.add(run.id);
    paired.add(key);
    const artifact = run.side === "A" ? plan.a : plan.b;
    if (
      artifact.id !== run.artifact.id ||
      artifact.sha256 !== run.artifact.sha256 ||
      JSON.stringify(plan.binding) !== JSON.stringify(run.binding)
    ) {
      throw new Error(`${run.id}: artifact or profile binding mismatch`);
    }
    const launches = inspect(run, plan);
    const legacy = launches.filter((launch) => !launch.ownerControlled);
    const mode = run.side === "A" ? c.aMode : c.bMode;
    if (run.side === "B" && legacy.length !== 0) {
      throw new Error(`${run.id}: managed transport outside owner lineage (${legacy[0]?.image})`);
    }
    if (run.outcome !== (run.side === "A" ? c.aOutcome : c.bOutcome)) {
      throw new Error(`${run.id}: unexpected action outcome`);
    }
    if (
      mode === "legacy-baseline" || mode === "owner-only"
        ? !launches.some((launch) => launch.seq > run.begin && launch.seq < run.end)
        : launches.length !== 0
    ) {
      throw new Error(`${run.id}: transport count inconsistent with ${mode}`);
    }
    results.push({
      run: run.id,
      caseId: c.id,
      row: c.row,
      side: run.side,
      mode,
      legacyLaunches: legacy.length,
      ownerLaunches: launches.length - legacy.length,
    });
  }
  for (const id of cases.keys()) {
    if (!paired.has(`A:${id}`) || !paired.has(`B:${id}`))
      throw new Error(`${id}: missing A/B trace pair`);
  }
  return {
    status: "launch-traces-conform",
    retirement: "unproven",
    s4Accepted: false,
    binding: plan.binding,
    artifacts: { a: plan.a, b: plan.b },
    results,
  } as const;
}
