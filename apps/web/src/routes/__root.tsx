import { QueryClient } from "@tanstack/react-query";
import {
  Outlet,
  createRootRouteWithContext,
  type ErrorComponentProps,
} from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { APP_BASE_NAME, APP_DISPLAY_NAME } from "../config/branding";
import { CommandPalette } from "../components/layout/CommandPalette";
import { AppSidebarLayout } from "../components/layout/AppSidebarLayout";
import { StartupSplash } from "../components/layout/StartupSplash";
import { Button } from "../components/ui/button";
import { AnchoredToastProvider, ToastProvider } from "../components/ui/toast";
import {
  SlowRpcAckToastCoordinator,
  WebSocketConnectionCoordinator,
  WebSocketConnectionSurface,
} from "../components/WebSocketConnectionSurface";
import { readNativeApi } from "../rpc/nativeApi";
import { PendingApprovalCoordinator } from "../notifications/pendingApprovalCoordinator";
import { TaskCompletionNotifications } from "../notifications/taskCompletion";
import { useStore } from "../stores/main";
import { EventRouter, ServerStateBootstrap } from "./__root.logic";

const STARTUP_SPLASH_EXIT_DURATION_MS = 220;

export const Route = createRootRouteWithContext<{
  queryClient: QueryClient;
}>()({
  component: RootRouteView,
  errorComponent: RootRouteErrorView,
  head: () => ({
    meta: [{ name: "title", content: APP_BASE_NAME }],
  }),
});

function RootRouteView() {
  const bootstrapComplete = useStore((store) => store.bootstrapComplete);
  const [showStartupSplash, setShowStartupSplash] = useState(() => !bootstrapComplete);
  const [startupSplashVisible, setStartupSplashVisible] = useState(() => !bootstrapComplete);

  useEffect(() => {
    if (!bootstrapComplete) {
      setShowStartupSplash(true);
      setStartupSplashVisible(true);
      return;
    }

    setShowStartupSplash(true);
    const animationFrameId = window.requestAnimationFrame(() => {
      setStartupSplashVisible(false);
    });
    const timeoutId = window.setTimeout(() => {
      setShowStartupSplash(false);
    }, STARTUP_SPLASH_EXIT_DURATION_MS);

    return () => {
      window.cancelAnimationFrame(animationFrameId);
      window.clearTimeout(timeoutId);
    };
  }, [bootstrapComplete]);

  if (!readNativeApi()) {
    return <StartupSplash />;
  }

  return (
    <ToastProvider>
      <AnchoredToastProvider>
        <ServerStateBootstrap />
        <EventRouter />
        <WebSocketConnectionCoordinator />
        <SlowRpcAckToastCoordinator />
        <PendingApprovalCoordinator />
        <TaskCompletionNotifications />
        <WebSocketConnectionSurface>
          {bootstrapComplete ? (
            <div className="relative h-screen overflow-hidden">
              <CommandPalette>
                <AppSidebarLayout>
                  <Outlet />
                </AppSidebarLayout>
              </CommandPalette>

              {showStartupSplash ? (
                <StartupSplash
                  className={`pointer-events-none absolute inset-0 z-50 transition-opacity duration-[220ms] ease-out ${
                    startupSplashVisible ? "opacity-100" : "opacity-0"
                  }`}
                />
              ) : null}
            </div>
          ) : (
            <StartupSplash />
          )}
        </WebSocketConnectionSurface>
      </AnchoredToastProvider>
    </ToastProvider>
  );
}

function RootRouteErrorView({ error, reset }: ErrorComponentProps) {
  const message = errorMessage(error);
  const details = errorDetails(error);

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-4 py-10 text-foreground sm:px-6">
      <div className="pointer-events-none absolute inset-0 opacity-80">
        <div className="absolute inset-x-0 top-0 h-44 bg-[radial-gradient(44rem_16rem_at_top,color-mix(in_srgb,var(--color-red-500)_16%,transparent),transparent)]" />
        <div className="absolute inset-0 bg-[linear-gradient(145deg,color-mix(in_srgb,var(--background)_90%,var(--color-black))_0%,var(--background)_55%)]" />
      </div>

      <section className="relative w-full max-w-xl rounded-2xl border border-border/80 bg-card/90 p-6 shadow-2xl shadow-black/20 backdrop-blur-md sm:p-8">
        <p className="text-[11px] font-semibold tracking-[0.18em] text-muted-foreground uppercase">
          {APP_DISPLAY_NAME}
        </p>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl">
          Something went wrong.
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{message}</p>

        <div className="mt-5 flex flex-wrap gap-2">
          <Button size="sm" onClick={() => reset()}>
            Try again
          </Button>
          <Button size="sm" variant="outline" onClick={() => window.location.reload()}>
            Reload app
          </Button>
        </div>

        <details className="group mt-5 overflow-hidden rounded-lg border border-border/70 bg-background/55">
          <summary className="cursor-pointer list-none px-3 py-2 text-xs font-medium text-muted-foreground">
            <span className="group-open:hidden">Show error details</span>
            <span className="hidden group-open:inline">Hide error details</span>
          </summary>
          <pre className="max-h-56 overflow-auto border-t border-border/70 bg-background/80 px-3 py-2 text-xs text-foreground/85">
            {details}
          </pre>
        </details>
      </section>
    </div>
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }

  return "An unexpected router error occurred.";
}

function errorDetails(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  try {
    return JSON.stringify(error, null, 2);
  } catch {
    return "No additional error details are available.";
  }
}
