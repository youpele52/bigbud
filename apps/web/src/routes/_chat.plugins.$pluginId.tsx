import { createFileRoute } from "@tanstack/react-router";

import { PluginDetailsPage } from "~/components/plugins/PluginDetailsPage";

export const Route = createFileRoute("/_chat/plugins/$pluginId")({ component: PluginDetailsPage });
