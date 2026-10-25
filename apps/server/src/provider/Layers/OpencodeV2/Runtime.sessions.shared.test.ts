import { expect, it } from "vitest";
import { conservedSharedPolicy } from "./Runtime.sessions.shared.ts";
import type { PermissionRuleset } from "@opencode/client";

const required: PermissionRuleset = [
  { action: "*", resource: "*", effect: "ask" },
  { action: "read", resource: "/known/native/**", effect: "deny" },
];
it("retains byte-identical legacy rule order and extra deny-only protections", () => {
  const legacy: PermissionRuleset = [
    ...required,
    { action: "edit", resource: "/custom/native/**", effect: "deny" },
  ];
  expect(conservedSharedPolicy(legacy, required)).toBe(legacy);
  expect(JSON.stringify(conservedSharedPolicy(legacy, required))).toBe(JSON.stringify(legacy));
});
it("rejects unknown/broadened grants, shadowed mandatory denies and missing known protection", () => {
  expect(() => conservedSharedPolicy([required[1]!, required[0]!], required)).toThrow("grants");
  expect(() =>
    conservedSharedPolicy(
      [{ action: "*", resource: "*", effect: "allow" }, required[1]!],
      required,
    ),
  ).toThrow("grants");
  expect(() => conservedSharedPolicy([required[0]!], required)).toThrow("mandatory");
  expect(() =>
    conservedSharedPolicy(
      [...required, { action: "read", resource: "\0unknown", effect: "deny" }],
      required,
    ),
  ).toThrow("grammar");
});
