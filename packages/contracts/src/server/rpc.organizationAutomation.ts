import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";
import {
  OrganizationAutomationError,
  ORGANIZATION_AUTOMATION_METHODS,
  OrganizationAutomationStatus,
  OrganizationEngagementInput,
} from "./organizationAutomation";
export const WsOrganizationStatusRpc = Rpc.make(ORGANIZATION_AUTOMATION_METHODS.status, {
  payload: Schema.Struct({}),
  success: OrganizationAutomationStatus,
  error: OrganizationAutomationError,
});
export const WsOrganizationEngagementRpc = Rpc.make(ORGANIZATION_AUTOMATION_METHODS.engagement, {
  payload: OrganizationEngagementInput,
  success: Schema.Boolean,
  error: OrganizationAutomationError,
});
