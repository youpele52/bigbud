import { expect, it } from "vitest";
import { ownerPermission, type OwnerPermissionContext, type OwnerOperation } from "./permissions";
import { ownerEnvironment } from "./environment";
import { validateArtifactDag, type ArtifactDagNode } from "./artifactDag";
import { id, scopeFixture, inventoryFixture } from "./test.fixture";

it("denies role reflection, unscoped/stale/dormant work, and root domain synthesis", () => {
  const root: OwnerPermissionContext = {
    role: 1,
    disposition: "candidate",
    use: 1,
    currentFences: true,
    quiescing: false,
    controllerActive: false,
  };
  expect(ownerPermission(root, "commitRoot")).toBe(true);
  for (const operation of ["pulse", "issueGrant", "spawn", "cleanup"] as const)
    expect(ownerPermission(root, operation)).toBe(false);
  expect(ownerPermission({ ...root, disposition: "statusOnly" }, "beginQuiesce")).toBe(false);
  expect(ownerPermission({ ...root, disposition: "currentMain" }, "spawn")).toBe(false);
  const pty = { id: id(11), epoch: id(1), generation: "1" };
  for (const role of [2, 3, 4] as const) {
    const scoped: OwnerPermissionContext = {
      ...root,
      role,
      disposition: "active",
      scope: scopeFixture(role),
      use: role === 4 ? 3 : 1,
      controllerActive: true,
      ...(role === 4 ? { shutdownInventory: inventoryFixture() } : {}),
    };
    expect(ownerPermission(scoped, "issueGrant")).toBe(false);
    expect(ownerPermission(scoped, "commitRoot")).toBe(false);
    expect(ownerPermission(scoped, "spawn")).toBe(role === 2);
    const allowed: OwnerOperation =
      role === 2 ? "input" : role === 3 ? "checkpoint" : "domainSettlement";
    expect(ownerPermission({ ...scoped, quiescing: role === 4 }, allowed, pty)).toBe(true);
    expect(ownerPermission({ ...scoped, currentFences: false }, allowed, pty)).toBe(false);
    expect(ownerPermission({ ...scoped, disposition: "dormant" }, allowed, pty)).toBe(false);
    if (role !== 4)
      expect(ownerPermission(scoped, allowed, { ...pty, generation: "2" })).toBe(false);
  }
});

it("builds host/native env from fixed values and verified facts, not parent overrides", () => {
  const source = {
    NODE_OPTIONS: "--require evil",
    NODE_PATH: "evil",
    LD_PRELOAD: "evil",
    DYLD_LIBRARY_PATH: "evil",
    PATH: "evil",
    HOME: "evil",
    ROOT_SECRET: "synthetic",
    API_KEY: "synthetic",
    ELECTRON_RUN_AS_NODE: "0",
  };
  expect(
    ownerEnvironment({
      target: "unix",
      runtime: "electronHost",
      scratchDirectory: "/synthetic/scratch",
    }),
  ).toEqual({
    LANG: "C",
    LC_ALL: "C",
    TZ: "UTC",
    ELECTRON_RUN_AS_NODE: "1",
    TMPDIR: "/synthetic/scratch",
  });
  expect(() => ownerEnvironment({ target: "unix", runtime: "native", ...source })).toThrow(
    "ENVIRONMENT_INVALID",
  );
  expect(
    ownerEnvironment({ target: "windows", runtime: "native", systemDirectory: "C:\\Windows" }),
  ).toEqual({ LANG: "C", LC_ALL: "C", TZ: "UTC", SystemRoot: "C:\\Windows" });
  expect(() => ownerEnvironment({ target: "windows", runtime: "native" })).toThrow(
    "ENVIRONMENT_INVALID",
  );
  expect(source.NODE_OPTIONS).toBe("--require evil"); // Shell environment remains untouched.
});

it("requires leaf-first acyclic graph and refuses self/main-image/ASAR manifest entries", () => {
  const graph: ArtifactDagNode[] = [
    { id: "runtime", kind: "leaf", dependencies: [], finalized: true },
    { id: "host", kind: "leaf", dependencies: ["runtime"], finalized: true },
    { id: "M", kind: "manifest", dependencies: ["runtime", "host"], finalized: true },
    { id: "main", kind: "mainBundle", dependencies: ["M"], finalized: true },
    { id: "A", kind: "asar", dependencies: ["main"], finalized: true },
    { id: "exe", kind: "mainImage", dependencies: ["A"], finalized: true },
    { id: "P", kind: "package", dependencies: ["exe"], finalized: true },
  ];
  expect(validateArtifactDag(graph)).toEqual(graph.map((n) => n.id));
  for (const ancestor of ["M", "A", "exe"])
    expect(() =>
      validateArtifactDag(
        graph.map((n) =>
          n.id === "M" ? { ...n, dependencies: [...n.dependencies, ancestor] } : n,
        ),
      ),
    ).toThrow();
  expect(() =>
    validateArtifactDag(
      graph.map((n) => (n.id === "runtime" ? { ...n, dependencies: ["main"] } : n)),
    ),
  ).toThrow("ARTIFACT_DAG_CYCLE");
  expect(() =>
    validateArtifactDag(
      graph.map((n) => (n.id === "host" ? Object.assign({}, n, { finalized: false }) : n)),
    ),
  ).toThrow();
});
