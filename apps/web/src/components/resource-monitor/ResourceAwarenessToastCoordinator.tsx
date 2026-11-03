import { useEffect, useRef } from "react";
import { resourceMetricMaxAge } from "@bigbud/shared/resourceAwareness.metrics";
import { useNavigate } from "@tanstack/react-router";
import {
  mutateResourceAwareness,
  useResourceAwareness,
} from "~/stores/resource-monitor/resourceAwareness.store";
import { toastManager } from "../ui/toast.manager";

/** Mounted at the application root, independent of the monitor route or AI sessions. */
export function ResourceAwarenessToastCoordinator() {
  const { state } = useResourceAwareness();
  const navigate = useNavigate();
  const seen = useRef(new Set<string>());
  const visible = useRef(new Map<string, string>());
  useEffect(() => {
    const now = Date.now();
    const eligible =
      state?.preferences.enabled &&
      state.preferences.snoozedUntilMs <= now &&
      state.health === "healthy"
        ? state.alerts.filter(
            (alert) =>
              alert.state === "active" &&
              alert.notifiedAtMs &&
              now - alert.sampledAtMs <= resourceMetricMaxAge(alert.metric) &&
              alert.sampledAtMs <= now + 2000,
          )
        : [];
    const active = new Set(eligible.map((alert) => alert.id));
    for (const [id, toast] of visible.current) {
      if (!active.has(id)) {
        toastManager.close(toast);
        visible.current.delete(id);
      }
    }
    for (const alert of eligible.slice(0, 8)) {
      if (seen.current.has(alert.id) || alert.acknowledged) continue;
      seen.current.add(alert.id);
      if (seen.current.size > 256) seen.current.delete(seen.current.values().next().value!);
      const toast = toastManager.add({
        title: `Resource warning: ${alert.metric}`,
        type: "warning",
        timeout: 15000,
        description: (
          <span>
            {alert.scope}: {alert.entity} exceeded {alert.threshold.toLocaleString()} for a
            sustained period.{" "}
            <button
              className="underline"
              onClick={() => {
                void mutateResourceAwareness({ operation: "snooze", snoozeSeconds: 600 }).catch(
                  () => undefined,
                );
              }}
            >
              Snooze 10 minutes
            </button>
          </span>
        ),
        actionProps: {
          children: "Open monitor",
          onClick: () => {
            void navigate({ to: "/system-monitor" });
          },
        },
      });
      visible.current.set(alert.id, toast);
      void window.desktopBridge?.resourceAwarenessAcknowledge?.([alert.id]).catch(() => undefined);
    }
  }, [state, navigate]);
  useEffect(
    () => () => {
      for (const toast of visible.current.values()) toastManager.close(toast);
      visible.current.clear();
    },
    [],
  );
  return null;
}
