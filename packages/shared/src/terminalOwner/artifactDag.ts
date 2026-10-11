import { requireContract } from "./errors";

export interface ArtifactDagNode {
  readonly id: string;
  readonly kind: "leaf" | "manifest" | "mainBundle" | "asar" | "mainImage" | "package";
  /** Every embedding, importing or hash dependency, not just manifest hash edges. */
  readonly dependencies: readonly string[];
  readonly finalized: boolean;
}

/** Structural build-DAG check only. Does not authenticate a package, file or a claimed graph. */
export function validateArtifactDag(nodes: readonly ArtifactDagNode[]): readonly string[] {
  requireContract(nodes.length > 0 && nodes.length <= 69, "ARTIFACT_DAG_INVALID");
  const byId = new Map<string, ArtifactDagNode>();
  const ranks = { leaf: 0, manifest: 1, mainBundle: 2, asar: 3, mainImage: 4, package: 5 };
  for (const node of nodes) {
    requireContract(
      /^[A-Za-z0-9._-]{1,64}$/.test(node.id) &&
        node.kind in ranks &&
        !byId.has(node.id) &&
        node.dependencies.length <= 64 &&
        new Set(node.dependencies).size === node.dependencies.length &&
        node.finalized,
      "ARTIFACT_DAG_INVALID",
    );
    byId.set(node.id, node);
  }
  requireContract(
    nodes.filter((node) => node.kind === "leaf").length <= 64 &&
      ["manifest", "mainBundle", "asar", "mainImage", "package"].every(
        (kind) => nodes.filter((node) => node.kind === kind).length === 1,
      ),
    "ARTIFACT_DAG_INVALID",
  );
  const order: string[] = [];
  const visited = new Set<string>();
  const active = new Set<string>();
  function visit(node: ArtifactDagNode) {
    requireContract(!active.has(node.id), "ARTIFACT_DAG_CYCLE");
    if (visited.has(node.id)) return;
    active.add(node.id);
    for (const id of node.dependencies) {
      const dependency = byId.get(id);
      requireContract(dependency, "ARTIFACT_DAG_INVALID");
      visit(dependency);
      requireContract(
        node.kind === "leaf"
          ? dependency.kind === "leaf"
          : ranks[dependency.kind] < ranks[node.kind],
        "ARTIFACT_DAG_ANCESTOR",
      );
    }
    if (node.kind !== "leaf")
      requireContract(
        node.dependencies.some((id) => ranks[byId.get(id)!.kind] === ranks[node.kind] - 1),
        "ARTIFACT_DAG_INVALID",
      );
    active.delete(node.id);
    visited.add(node.id);
    order.push(node.id);
  }
  for (const node of nodes) visit(node);
  const manifest = nodes.find((node) => node.kind === "manifest")!;
  requireContract(
    manifest.dependencies.length > 0 &&
      nodes
        .filter((node) => node.kind === "leaf")
        .every((node) => manifest.dependencies.includes(node.id)),
    "ARTIFACT_DAG_INVALID",
  );
  return order;
}
