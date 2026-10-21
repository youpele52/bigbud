var __defProp = Object.defineProperty;
var __returnValue = (v) => v;
function __exportSetter(name, newValue) {
  this[name] = __returnValue.bind(null, newValue);
}
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, {
      get: all[name],
      enumerable: true,
      configurable: true,
      set: __exportSetter.bind(all, name),
    });
};

// packages/core/src/session/family.receipt.ts
var exports_family_receipt = {};
__export(exports_family_receipt, {
  verifyPayload: () => verifyPayload,
  root: () => root,
  read: () => read,
  payloadDigest: () => payloadDigest,
  operation: () => operation,
  evidence: () => evidence,
  NativeFamilyReceipt: () => exports_family_receipt,
});
import { createHash } from "node:crypto";
async function root(parent, id) {
  const seen = new Set();
  for (let depth = 0; depth <= 16; depth++) {
    if (seen.has(id)) throw new Error("Native family ancestry rejected");
    seen.add(id);
    const next = await parent(id);
    if (!next) return id;
    id = next;
  }
  throw new Error("Native family depth rejected");
}
function evidence(state, fenced, failed) {
  const pendingBySession = {};
  for (const op of state.operations) {
    if (op.done) continue;
    for (const id of new Set([op.ticket.parentID, ...(op.childID ? [op.childID] : [])]))
      pendingBySession[id] = (pendingBySession[id] ?? 0) + 1;
  }
  return {
    abi: state.abi,
    rootID: state.rootID,
    ownerID: state.ownerID,
    generation: state.generation,
    stopped: state.stopped || fenced,
    settled: state.settled && !failed,
    uncertain: state.uncertain || failed,
    pending: state.operations.filter((op) => !op.done).length,
    pendingBySession,
  };
}
function payloadDigest(input) {
  const canonical = (value) =>
    Array.isArray(value)
      ? value.map(canonical)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([key, entry]) => [key, canonical(entry)]),
          )
        : value;
  return createHash("sha256")
    .update(
      JSON.stringify(canonical([input.text, input.description ?? null, input.metadata ?? null])),
    )
    .digest("hex");
}
function verifyPayload(binding, receipt, body) {
  if (
    !binding ||
    typeof binding !== "object" ||
    !("digest" in binding) ||
    !("operationID" in binding) ||
    !("sessionID" in binding) ||
    binding.operationID !== receipt.operationID ||
    binding.sessionID !== receipt.parentID ||
    !body ||
    payloadDigest(body) !== binding.digest
  )
    throw new Error("Native family admission payload changed");
}
function operation(state, ticket) {
  const entry = state.operations.find((op) => op.ticket.operationID === ticket.operationID);
  if (!entry || Object.entries(entry.ticket).some(([key, value]) => ticket[key] !== value))
    throw new Error("Native family operation provenance rejected");
  return entry;
}
async function read(state, store, inputID) {
  if (await store.get(`native-family.v1/cancelled/${inputID}`))
    throw new Error("Native family admission was cancelled");
  const proof = await store.get(`native-family.v1/origin/${inputID}`);
  if (
    !proof ||
    proof.rootID !== state.rootID ||
    proof.ownerID !== state.ownerID ||
    proof.generation !== state.generation ||
    proof.notificationID !== inputID
  )
    throw new Error("Native family input has no authenticated admission receipt");
  const entry = operation(state, proof);
  if (
    entry.childID !== proof.childID ||
    entry.notificationID !== inputID ||
    entry.jobGeneration !== proof.jobGeneration
  )
    throw new Error("Native family input receipt changed job generation");
  const consumed = await store.get(`native-family.v1/consumed/${inputID}`);
  return { ...proof, consumed: consumed?.operationID === proof.operationID };
}

export {
  __export,
  root,
  evidence,
  payloadDigest,
  verifyPayload,
  operation,
  read,
  exports_family_receipt,
};
