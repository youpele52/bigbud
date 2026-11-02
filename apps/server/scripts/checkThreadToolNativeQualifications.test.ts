import { expect, it } from "vitest";
import { nativeBootstrapGeneratorSourceDigest } from "./checkThreadToolNativeQualifications.ts";

it("includes policy action source bytes in the bootstrap generator identity", async () => {
  const names: string[] = [];
  const original = await nativeBootstrapGeneratorSourceDigest(async (name) => {
    names.push(name);
    return name;
  });
  expect(names).toContain("NativeCompatibility.policy.actions.ts");
  const changed = await nativeBootstrapGeneratorSourceDigest(async (name) =>
    name === "NativeCompatibility.policy.actions.ts"
      ? `${name}\n// changed policy semantics`
      : name,
  );
  expect(changed).not.toBe(original);
  expect(names.some((name) => name.includes("qualification.registry"))).toBe(false);
});
