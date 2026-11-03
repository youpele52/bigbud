import { useState } from "react";
import {
  mutateResourceAwareness,
  useResourceAwareness,
} from "~/stores/resource-monitor/resourceAwareness.store";
import { Button } from "../ui/button";
import { ResourceRuleEditor } from "./ResourceRuleEditor";

export function ResourceAwarenessSettings() {
  const { state, error } = useResourceAwareness();
  const [pending, setPending] = useState(false);
  if (typeof window === "undefined" || !window.desktopBridge?.resourceAwarenessGet) return null;
  if (!state) return <p className="text-sm">Resource alert settings unavailable. {error}</p>;
  const mutate = (input: Parameters<typeof mutateResourceAwareness>[0]) => {
    setPending(true);
    void mutateResourceAwareness(input)
      .catch(() => undefined)
      .finally(() => setPending(false));
  };
  return (
    <details className="rounded-md border p-4 text-sm">
      <summary className="cursor-pointer">Background resource alerts — {state.health}</summary>
      <div className="mt-4 flex flex-col gap-3">
        {state.alertsTruncated && (
          <p role="alert">
            Rule evidence or alert display reached its bounded capacity. Narrow wildcard rules; this
            is not a complete host-wide assessment.
          </p>
        )}
        {state.appStatus && state.appStatus !== "ready" && (
          <p>App attribution: {state.appStatus}. Host monitoring remains independent.</p>
        )}
        <p className="text-xs text-muted-foreground">
          Runs while bigbud is open, even with this page closed. No monitoring after quit.
          Temperatures require supported hardware; a blank temperature threshold uses a reported
          critical limit, otherwise stays unarmed. Core excludes tools; inclusive includes
          attributed tool descendants. Unknown, stale and incomplete data never trigger alerts.
        </p>
        <p className="text-xs text-muted-foreground">
          CPU thresholds use percent of host capacity. Host RAM and disk thresholds use percent;
          appMemory uses summed RSS bytes (an estimate, not unique physical memory); temperature
          uses °C. Sustain/cooldown use seconds. Recovery must be lower than threshold. Disk
          defaults require both high usage and low free space; free-space recovery is an alternative
          to percentage recovery.
        </p>
        <label className="flex gap-2">
          <input
            type="checkbox"
            disabled={pending}
            checked={state.preferences.enabled}
            onChange={(event) => mutate({ operation: "enable", enabled: event.target.checked })}
          />
          Enable background monitoring
        </label>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={pending}
            onClick={() => mutate({ operation: "snooze", snoozeSeconds: 600 })}
          >
            Snooze 10 minutes
          </Button>
          <Button
            variant="outline"
            disabled={pending}
            onClick={() => mutate({ operation: "snooze", snoozeSeconds: 0 })}
          >
            Resume alerts
          </Button>
          <Button
            variant="outline"
            disabled={pending}
            onClick={() => mutate({ operation: "reset" })}
          >
            Reset defaults
          </Button>
          <Button
            variant="outline"
            disabled={pending || state.preferences.rules.length >= 64}
            onClick={() =>
              mutate({
                operation: "upsert",
                rule: {
                  id: `app-budget-${crypto.randomUUID().slice(0, 8)}`,
                  metric: "appMemory",
                  scope: "core",
                  enabled: false,
                  threshold: 4 * 1024 ** 3,
                  recovery: 3 * 1024 ** 3,
                  sustainSeconds: 60,
                  cooldownSeconds: 600,
                },
              })
            }
          >
            Add rule
          </Button>
        </div>
        {state.preferences.snoozedUntilMs > Date.now() && (
          <p>
            Alerts snoozed until {new Date(state.preferences.snoozedUntilMs).toLocaleTimeString()}.
          </p>
        )}
        {(error || state.diagnostic) && (
          <p role="alert" className="text-destructive">
            {error ?? state.diagnostic}
          </p>
        )}
        {state.alerts.map((alert) => (
          <p key={alert.id}>
            {alert.metric} ({alert.scope}, {alert.entity}): {alert.state}; observed{" "}
            {new Date(alert.sampledAtMs).toLocaleTimeString()}.
          </p>
        ))}
        {state.preferences.rules.map((rule) => (
          <ResourceRuleEditor key={`${state.preferences.revision}:${rule.id}`} rule={rule} />
        ))}
      </div>
    </details>
  );
}
