export function isAutomationRoute(pathname: string): boolean {
  return pathname === "/automations" || pathname.startsWith("/automations/");
}
