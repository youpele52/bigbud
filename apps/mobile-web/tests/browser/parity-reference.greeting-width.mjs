import assert from "node:assert/strict";

/** Compare shared copy within matched desktop/mobile transcript widths, not global y positions. */
export function assertGreetingCopyWidth(current, reference) {
  assert.ok(reference, "greeting needs its measured current desktop reference");
  assert.equal(current.copy.width, reference.copy.width, "avoid redundant mobile copy padding");
  assert.equal(current.copy.height, reference.copy.height, "matched copy should wrap equally");
}
