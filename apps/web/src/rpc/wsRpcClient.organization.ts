import type {
  OrganizationAutomationStatus,
  OrganizationEngagementInput,
} from "@bigbud/contracts/server/organizationAutomation.ts";
export interface OrganizationRpcClient {
  status: () => Promise<OrganizationAutomationStatus>;
  engagement: (input: OrganizationEngagementInput) => Promise<boolean>;
}
