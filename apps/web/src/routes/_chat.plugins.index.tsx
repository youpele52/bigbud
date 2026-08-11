import { createFileRoute } from "@tanstack/react-router";

import { PluginStorePage } from "~/components/plugins/PluginStorePage";

export const Route = createFileRoute("/_chat/plugins/")({ component: PluginStorePage });
