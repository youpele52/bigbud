import { expect, it } from "vitest";
import { validateV2WindowsAcl, V2_WINDOWS_ACL_PROGRAM } from "./ProfileIsolation.windows.mjs";

const sid = "S-1-5-21-100-200-300-400";
const rule = { sid, allow: true, rights: 2032127 };
const entry = (name: string, ancestor: boolean) => ({
  path: name,
  ancestor,
  directory: true,
  owner: sid,
  rules: [rule],
});
const valid = () => ({
  sid,
  entries: [
    entry("C:\\Users\\fixture\\v2", false),
    entry("C:\\Users\\fixture", true),
    entry("C:\\Users", true),
    entry("C:\\", true),
  ],
});
it("Windows ACL verification accepts only inspected owner/trusted ACEs and all ancestors, not mode guesses", () => {
  expect(() => validateV2WindowsAcl("C:\\Users\\fixture\\v2", valid())).not.toThrow();
  for (const rights of [1, 2, 2032127]) {
    const snapshot = valid();
    snapshot.entries[0]!.rules.push({ sid: "S-1-1-0", allow: true, rights });
    expect(() => validateV2WindowsAcl("C:\\Users\\fixture\\v2", snapshot)).toThrow("untrusted");
  }
  const writableParent = valid();
  writableParent.entries[1]!.rules.push({ sid: "S-1-5-11", allow: true, rights: 2 });
  expect(() => validateV2WindowsAcl("C:\\Users\\fixture\\v2", writableParent)).toThrow("untrusted");
  const missingParent = valid();
  missingParent.entries.pop();
  expect(() => validateV2WindowsAcl("C:\\Users\\fixture\\v2", missingParent)).toThrow("ancestor");
  const owner = valid();
  owner.entries[0]!.owner = "S-1-5-18";
  expect(() => validateV2WindowsAcl("C:\\Users\\fixture\\v2", owner)).toThrow("owner");
  const empty = valid();
  empty.entries[0]!.rules = [];
  expect(() => validateV2WindowsAcl("C:\\Users\\fixture\\v2", empty)).toThrow("DACL");
  expect(V2_WINDOWS_ACL_PROGRAM).toContain("Get-Acl -LiteralPath");
  expect(V2_WINDOWS_ACL_PROGRAM).toContain("ReparsePoint");
  expect(V2_WINDOWS_ACL_PROGRAM).not.toContain("Set-Acl");
});
