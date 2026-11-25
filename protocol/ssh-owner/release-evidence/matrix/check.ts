import { token } from "../cutover/evidence.ts";
import { requiredLanes, slots } from "./catalog.ts";
import { array, binding, claim, object, type Binding, type Claim } from "./input.ts";

export function parseMatrixPlan(value: unknown) {
  const plan = object(value, ["kind", "scopeReview", "cells"]);
  if (plan.kind !== "s4-matrix-plan-v1") throw new Error("Expected a reviewed matrix plan");
  const scopeReview = token(plan.scopeReview);
  const cells = new Map<string, Binding>();
  const dispositions = new Map<string, Binding["disposition"]>();
  const profiles = new Set<string>();
  const buildPairs = new Set<string>();
  for (const input of array(plan.cells)) {
    const current = binding(input);
    const prior = dispositions.get(current.slot.id);
    if (
      cells.has(current.cell) ||
      (prior && (prior !== "required" || current.disposition !== prior))
    ) {
      throw new Error(`${current.cell}: duplicate or conflicting scope cell`);
    }
    dispositions.set(current.slot.id, current.disposition);
    cells.set(current.cell, current);
    if (current.identity) {
      const { a, b, migration, schemaA } = current.identity;
      profiles.add(current.slot.profile);
      buildPairs.add(JSON.stringify([a.build, b.build, migration, schemaA]));
    }
  }
  const missing = slots.filter((slot) => !dispositions.has(slot.id));
  if (missing.length)
    throw new Error(`Missing scope slots: ${missing.map((slot) => slot.id).join(", ")}`);
  if (!profiles.has("V-E") || !profiles.has("V-B")) {
    throw new Error("Both development profiles need independently reviewed supported cells");
  }
  if (buildPairs.size !== 1)
    throw new Error("Matrix cells must bind one A/B build and schema pair");
  return { cells, scopeReview };
}

function checkClaims(expected: Binding, input: unknown, usedRefs: Set<string>) {
  const { cell, slot, identity } = expected;
  const claims = new Map<string, Claim>();
  for (const value of array(input)) {
    const entry = claim(value);
    if (claims.has(entry.lane) || usedRefs.has(entry.ref)) {
      throw new Error(`${cell}/${entry.lane}: duplicate lane or reused claim reference`);
    }
    claims.set(entry.lane, entry);
    usedRefs.add(entry.ref);
  }
  const lanes = identity
    ? requiredLanes(slot, identity.askpass !== null)
    : {
        "scope-exclusion":
          slot.disposition === "excluded"
            ? "outside-artifact-matrix"
            : "reviewed-unsupported-development",
      };
  for (const [lane, result] of Object.entries(lanes)) {
    const entry = claims.get(lane);
    if (!entry) throw new Error(`${cell}: missing required lane ${lane}`);
    const authDecision = lane === "inbox-login-password" || lane === "inbox-keyboard-interactive";
    if (
      authDecision &&
      entry.result === "approved-auth-denial-before-collection" &&
      entry.decision
    ) {
      continue;
    }
    const needsDecision =
      (lane === "scope-exclusion" && slot.disposition === "review-scope") ||
      (lane === "provenance" && identity?.artifactVerification === "approved-unsigned-release");
    if (entry.result !== result || (entry.decision !== null) !== needsDecision) {
      throw new Error(`${cell}/${lane}: mismatched result or missing explicit scope/auth decision`);
    }
    if (authDecision && !identity?.askpass) {
      throw new Error(`${cell}/${lane}: qualified auth requires native askpass image identity`);
    }
  }
  if (Object.keys(lanes).length !== claims.size) throw new Error(`${cell}: unexpected claim lane`);
  return { cell, slot: slot.id, references: claims.size };
}

export function checkMatrix(planInput: unknown, claimsInput: unknown) {
  const { cells, scopeReview } = parseMatrixPlan(planInput);
  const bundle = object(claimsInput, ["kind", "scopeReview", "cells"]);
  if (bundle.kind !== "s4-matrix-claim-references-v1" || bundle.scopeReview !== scopeReview) {
    throw new Error(
      "Expected verified claim references for this scope review, not preflight output",
    );
  }
  const seen = new Set<string>();
  const usedRefs = new Set<string>();
  const coverage = [];
  for (const input of array(bundle.cells)) {
    const entry = object(input, ["binding", "claims"]);
    const actual = binding(entry.binding);
    const expected = cells.get(actual.cell);
    if (!expected || seen.has(actual.cell) || JSON.stringify(expected) !== JSON.stringify(actual)) {
      throw new Error(`${actual.cell}: unexpected, duplicate or mismatched matrix binding`);
    }
    seen.add(actual.cell);
    coverage.push(checkClaims(expected, entry.claims, usedRefs));
  }
  const missing = [...cells.keys()].filter((cell) => !seen.has(cell));
  if (missing.length) throw new Error(`Missing claim cells: ${missing.join(", ")}`);
  return {
    status: "matrix-claim-coverage-conforms",
    referencesAuthenticated: false,
    s4Accepted: false,
    coverage,
  } as const;
}
