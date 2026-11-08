// Only disposable projection fields. Runtime policy/completion/receipt state must NEVER be
// embedded into, restored from, or rewound by a historical projection baseline.
export function normalizeOrganizationAgeRow(row: Record<string, unknown>): Record<string, unknown> {
  const revision = row.organization_revision ?? 0;
  const changedAt = row.organization_changed_at ?? null;
  const legacy = !Object.hasOwn(row, "organization_age_provenance");
  return {
    ...row,
    organization_state: row.organization_state ?? "present",
    organization_revision: revision,
    organization_changed_at: changedAt,
    organization_snooze_id: row.organization_snooze_id ?? null,
    organization_snooze_until: row.organization_snooze_until ?? null,
    organization_activity_at: legacy ? changedAt : (row.organization_activity_at ?? null),
    organization_age_provenance:
      revision === 0 ? "known" : legacy ? "fallback" : row.organization_age_provenance,
  };
}
