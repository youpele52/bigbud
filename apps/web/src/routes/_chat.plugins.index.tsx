import { createFileRoute } from "@tanstack/react-router";

// The parent route redirects this legacy URL; no marketplace UI is mounted.
export const Route = createFileRoute("/_chat/plugins/")({});
