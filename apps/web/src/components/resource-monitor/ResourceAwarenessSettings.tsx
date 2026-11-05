import { useState } from "react";
import {
  mutateResourceAwareness,
  useResourceAwareness,
} from "~/stores/resource-monitor/resourceAwareness.store";
import { ActivityAccordion } from "../chat/common/ActivityAccordion";
import { SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { ResourceRuleEditor } from "./ResourceRuleEditor";

const HEALTH_LABELS = {
  healthy: "Monitoring active",
  warming: "Waiting for readings",
  unavailable: "Monitor unavailable",
  disabled: "Monitoring off",
} as const;

export function ResourceAwarenessSettings() {
  const { state, error } = useResourceAwareness();
  const [pending, setPending] = useState(false);
  if (typeof window === "undefined" || !window.desktopBridge?.resourceAwarenessGet) return null;

  const mutate = (input: Parameters<typeof mutateResourceAwareness>[0]) => {
    setPending(true);
    void mutateResourceAwareness(input)
      .catch(() => undefined)
      .finally(() => setPending(false));
  };

  return (
    <SettingsSection title="Background resource alerts">
      <SettingsRow
        title="Monitor system resources"
        description="Warn when CPU, memory, storage, or a supported temperature sensor stays above its limit. Runs while bigbud is open, even with the monitor page closed."
        status={state ? HEALTH_LABELS[state.health] : "Waiting for desktop monitor"}
        control={
          <Switch
            tone="success"
            checked={state?.preferences.enabled ?? false}
            disabled={pending || !state}
            onCheckedChange={(checked) =>
              mutate({ operation: "enable", enabled: Boolean(checked) })
            }
            aria-label="Enable background monitoring"
          />
        }
      >
        {(error || state?.diagnostic) && (
          <p role="alert" className="pt-2 text-xs text-destructive">
            {error ?? state?.diagnostic}
          </p>
        )}
      </SettingsRow>
      <SettingsRow
        title="Pause warnings"
        description="Temporarily stop resource alerts without changing your rules or stopping monitoring."
        status={
          state && state.preferences.snoozedUntilMs > Date.now()
            ? `Snoozed until ${new Date(state.preferences.snoozedUntilMs).toLocaleTimeString()}`
            : "Alerts are not snoozed"
        }
        control={
          <Button
            variant="outline"
            disabled={pending || !state}
            onClick={() =>
              mutate({
                operation: "snooze",
                snoozeSeconds: state && state.preferences.snoozedUntilMs > Date.now() ? 0 : 600,
              })
            }
          >
            {state && state.preferences.snoozedUntilMs > Date.now()
              ? "Resume alerts"
              : "Snooze 10 minutes"}
          </Button>
        }
      />
      <SettingsRow
        title="Alert rules"
        description="Set your thresholds and recovery limits. Temperature alerts need a supported sensor; unknown or stale readings never trigger warnings."
        searchTerms={["CPU", "RAM", "disk", "temperature", "threshold", "snooze"]}
      >
        <ActivityAccordion
          title="Edit alert rules"
          variant="compact"
          className="mt-3"
          summaryClassName="text-sm text-foreground/80 hover:text-foreground"
          panelClassName="space-y-3 pt-4"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              CPU and RAM use host percentages. Disk space and bigbud memory are shown in GiB. Core
              excludes tools; inclusive includes attributed tool processes.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                disabled={pending || !state}
                onClick={() => mutate({ operation: "reset" })}
              >
                Restore default rules
              </Button>
              <Button
                variant="outline"
                disabled={pending || !state || state.preferences.rules.length >= 64}
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
          </div>
          {state?.alertsTruncated && (
            <p role="alert" className="text-xs text-amber-600">
              Some readings were capped; wildcard rules may not cover every device.
            </p>
          )}
          {state?.appStatus && state.appStatus !== "ready" && (
            <p className="text-xs text-muted-foreground">
              bigbud usage: {state.appStatus}. Host monitoring is unaffected.
            </p>
          )}
          <div className="divide-y divide-border/60 rounded-lg border border-border/60">
            {state?.preferences.rules.map((rule) => (
              <ResourceRuleEditor key={`${state.preferences.revision}:${rule.id}`} rule={rule} />
            ))}
          </div>
        </ActivityAccordion>
      </SettingsRow>
    </SettingsSection>
  );
}
