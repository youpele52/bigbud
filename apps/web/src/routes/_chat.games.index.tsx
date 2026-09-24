import { createFileRoute } from "@tanstack/react-router";
import { GamesPage } from "~/components/games/GamesPage";

export const Route = createFileRoute("/_chat/games/")({ component: GamesPage });
