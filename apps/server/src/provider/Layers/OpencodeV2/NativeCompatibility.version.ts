/** Every stable V2 release is a candidate; API/bridge checks, not patch numbers, grant readiness. */
export function parseV2CanonicalCandidate(value: unknown) {
  if (typeof value !== "string" || value.length > 50) return undefined;
  const parts = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  const numbers = parts?.slice(1).map(Number);
  if (!numbers || numbers.some((part) => !Number.isSafeInteger(part)) || numbers[0] !== 2)
    return undefined;
  return Object.freeze({
    version: value,
    major: 2 as const,
    minor: numbers[1]!,
    patch: numbers[2]!,
  });
}

/** Generator-owned policy only; release qualifications must never enter native module bytes. */
export function renderV2CanonicalCandidateGuard() {
  return `function candidate(version) {
 if(typeof version!=="string"||version.length>50)return false;
 const match=/^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)$/.exec(version),parts=match?.slice(1).map(Number);
 return Boolean(parts&&parts.every(Number.isSafeInteger)&&parts[0]===2);
}`;
}
