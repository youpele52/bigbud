import { expect, it } from "vitest";
import { withV2OwnedFamily } from "./Runtime.family.fixture.ts";

it("enforces live capacity before new AND resumed child prompts, without truncating away owned executable descendants", async () => {
  await withV2OwnedFamily(async ({ owner, http, launch, finish }) => {
    await launch("ses_retained_terminal");
    finish("ses_retained_terminal");
    await owner.family!.observe("ses_retained_terminal", "terminal");
    for (let index = 0; index < 32; index++) await launch(`ses_capacity_${index}`);
    const prompts = http.calls.filter((call) => call.pathname.endsWith("/prompt")).length;
    await expect(launch("ses_overflow")).rejects.toThrow("live descendant capacity");
    await expect(launch("ses_retained_terminal")).rejects.toThrow("live descendant capacity");
    expect(owner.family!.children).toHaveLength(33);
    expect(owner.family!.children.filter((child) => child.state !== "terminal")).toHaveLength(32);
    expect(http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(prompts);
    expect(owner.family!.child("ses_overflow")).toBeUndefined();
  });
});
