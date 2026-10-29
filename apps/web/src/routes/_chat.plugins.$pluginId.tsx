import { createFileRoute } from "@tanstack/react-router";

// The parent route also redirects old detail links without resolving an installation.
export const Route = createFileRoute("/_chat/plugins/$pluginId")({});
