import { SPINNER_VERBS } from "./constants/spinnerVerbs";

/** Returns a random verb from SPINNER_VERBS. */
export function randomSpinnerVerb(): string {
  return SPINNER_VERBS[Math.floor(Math.random() * SPINNER_VERBS.length)] as string;
}

/**
 * Returns a stable verb for a given ID by hashing the string into an index.
 * The same ID always produces the same verb, regardless of re-renders.
 */
export function stableVerbFromId(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  }
  return SPINNER_VERBS[hash % SPINNER_VERBS.length] as string;
}
