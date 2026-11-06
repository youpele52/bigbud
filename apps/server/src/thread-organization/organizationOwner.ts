import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { OrganizationPolicy, OrganizationRow } from "./organizationProtocol.ts";

export interface OrganizationOwner {
  backendNonce: string;
  generation: number;
  active: boolean;
  observedAtMs: number;
  policy: OrganizationPolicy;
  idleNotBeforeMs: number;
  rows: ReadonlyMap<string, OrganizationRow>;
  /** Marks threads for a prompt fact refresh (e.g. engagement lease changes). Never schedules. */
  observe?: (threadIds: readonly string[]) => void;
}
// Owner capability is scoped to the server's SQL client, never received over RPC.
// Losing a child fences acceptance immediately; persisted receipts remain authoritative.
const owners = new WeakMap<SqlClient.SqlClient, OrganizationOwner>();
export function organizationOwner(sql: SqlClient.SqlClient) {
  return owners.get(sql);
}
export function installOrganizationOwner(sql: SqlClient.SqlClient, owner: OrganizationOwner) {
  owners.set(sql, owner);
  return () => {
    owner.active = false;
    if (owners.get(sql) === owner) owners.delete(sql);
  };
}
