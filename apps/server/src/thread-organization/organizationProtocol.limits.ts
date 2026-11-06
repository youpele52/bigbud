import { ORGANIZATION_LIMITS, type OrganizationLimits } from "./organizationProtocol.ts";

export function validateOrganizationLimits(limits: OrganizationLimits): void {
  for (const key of Object.keys(ORGANIZATION_LIMITS) as (keyof OrganizationLimits)[]) {
    const value = limits[key];
    if (!Number.isSafeInteger(value) || value <= 0 || value > ORGANIZATION_LIMITS[key])
      throw new RangeError("invalid organisation limits");
  }
}
