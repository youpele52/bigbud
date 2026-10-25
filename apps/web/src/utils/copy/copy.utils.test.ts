import { expect, it, vi } from "vitest";

import { randomSpinnerVerb, SPINNER_VERBS } from "./copy.utils";

it.each(["Buzzing", "SIUUU-ing"] as const)("includes %s as a selectable spinner verb", (verb) => {
  const index = SPINNER_VERBS.indexOf(verb);
  expect(index).toBeGreaterThanOrEqual(0);

  const random = vi.spyOn(Math, "random").mockReturnValue((index + 0.5) / SPINNER_VERBS.length);
  try {
    expect(randomSpinnerVerb()).toBe(verb);
  } finally {
    random.mockRestore();
  }
});
