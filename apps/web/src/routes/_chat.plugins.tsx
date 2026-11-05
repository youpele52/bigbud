import { createFileRoute, redirect } from "@tanstack/react-router";

/** Keep retired marketplace URLs out of the dynamic thread route and restoration. */
export function redirectRetiredMarketplace(): never {
  throw redirect({ to: "/", replace: true });
}

export const Route = createFileRoute("/_chat/plugins")({ beforeLoad: redirectRetiredMarketplace });
