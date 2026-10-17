import { expect, it } from "vitest";
import {
  validateV2WindowsAcl,
  V2_WINDOWS_ACL_PROGRAM,
  v2WindowsPowerShellEnvironment,
} from "./ProfileIsolation.windows.mjs";

it("prevents inherited PS7 or case-aliased module paths from redirecting Windows ACL inspection", () => {
  const environment = {
    SystemRoot: "C:\\Windows",
    PSModulePath: "C:\\untrusted",
    PSMODULEPATH: "C:\\PS7",
    TEMP: "C:\\fixture",
  };
  const child = v2WindowsPowerShellEnvironment(environment);
  expect(child.PSModulePath).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules");
  expect(child).not.toHaveProperty("PSMODULEPATH");
  expect(child.TEMP).toBe(environment.TEMP);
  expect(environment.PSModulePath).toBe("C:\\untrusted");
});

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
it("trusts the exact Windows installer ancestor while keeping leaf ownership strict", () => {
  const installer = "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464";
  const snapshot = valid();
  snapshot.entries[3]!.owner = installer;
  snapshot.entries[3]!.rules.push({ sid: installer, allow: true, rights: 2032127 });
  expect(() => validateV2WindowsAcl("C:\\Users\\fixture\\v2", snapshot)).not.toThrow();
  snapshot.entries[0]!.owner = installer;
  expect(() => validateV2WindowsAcl("C:\\Users\\fixture\\v2", snapshot)).toThrow("owner");
});
it("ignores inherit-only ancestor grants but rejects effective child-deletion grants", () => {
  const snapshot = valid();
  const inherited = { sid: "S-1-3-0", allow: true, rights: 2032127, inheritOnly: true };
  snapshot.entries[3]!.rules.push(inherited);
  snapshot.entries[3]!.rules.push({ sid: "S-1-5-11", allow: true, rights: 4 });
  expect(() => validateV2WindowsAcl("C:\\Users\\fixture\\v2", snapshot)).not.toThrow();
  inherited.inheritOnly = false;
  expect(() => validateV2WindowsAcl("C:\\Users\\fixture\\v2", snapshot)).toThrow("untrusted");
});
it("Windows ACL verification accepts only inspected owner/trusted ACEs and all ancestors, not mode guesses", () => {
  expect(() => validateV2WindowsAcl("C:\\Users\\fixture\\v2", valid())).not.toThrow();
  for (const rights of [1, 2, 2032127]) {
    const snapshot = valid();
    snapshot.entries[0]!.rules.push({ sid: "S-1-1-0", allow: true, rights });
    expect(() => validateV2WindowsAcl("C:\\Users\\fixture\\v2", snapshot)).toThrow("untrusted");
  }
  const writableParent = valid();
  writableParent.entries[1]!.rules.push({ sid: "S-1-5-11", allow: true, rights: 0x40 });
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
