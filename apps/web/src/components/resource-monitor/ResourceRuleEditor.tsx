import { useState } from "react";
import type { ResourceRule } from "@bigbud/contracts/system-monitor/awareness.ts";
import { mutateResourceAwareness } from "~/stores/resource-monitor/resourceAwareness.store";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";

const GIB = 1024 ** 3;
const METRICS = [
  { value: "hostCpu", label: "System CPU" },
  { value: "hostMemory", label: "System memory" },
  { value: "disk", label: "Disk usage" },
  { value: "temperature", label: "Temperature" },
  { value: "appCpu", label: "bigbud CPU" },
  { value: "appMemory", label: "bigbud memory" },
] as const;

function fieldValue(rule: ResourceRule, field: keyof ResourceRule): string {
  const value = rule[field];
  return typeof value === "number"
    ? String(
        field === "minimumFreeBytes" ||
          field === "recoveryFreeBytes" ||
          (rule.metric === "appMemory" && (field === "threshold" || field === "recovery"))
          ? value / GIB
          : value,
      )
    : "";
}

export function ResourceRuleEditor({ rule }: { rule: ResourceRule }) {
  const [draft, setDraft] = useState(rule);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async (remove = false) => {
    setPending(true);
    setError(null);
    try {
      await mutateResourceAwareness(
        remove ? { operation: "remove", ruleId: rule.id } : { operation: "upsert", rule: draft },
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  };
  const updateNumber = (field: keyof ResourceRule, raw: string) => {
    const scale =
      field === "minimumFreeBytes" ||
      field === "recoveryFreeBytes" ||
      (draft.metric === "appMemory" && (field === "threshold" || field === "recovery"))
        ? GIB
        : 1;
    setDraft({ ...draft, [field]: raw === "" ? undefined : Number(raw) * scale });
  };
  const memory = draft.metric === "appMemory";
  const temperature = draft.metric === "temperature";
  const numericFields: Array<
    | "threshold"
    | "recovery"
    | "sustainSeconds"
    | "cooldownSeconds"
    | "minimumFreeBytes"
    | "recoveryFreeBytes"
  > = [
    "threshold",
    "recovery",
    "sustainSeconds",
    "cooldownSeconds",
    ...(draft.metric === "disk" ? (["minimumFreeBytes", "recoveryFreeBytes"] as const) : []),
  ];
  return (
    <form
      className="space-y-4 px-4 py-4 sm:px-5"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h4 className="text-sm font-medium text-foreground">
            {METRICS.find((metric) => metric.value === rule.metric)?.label ?? rule.id}
          </h4>
          <p className="text-xs text-muted-foreground">{rule.id}</p>
        </div>
        <Switch
          tone="success"
          checked={draft.enabled}
          disabled={pending}
          onCheckedChange={(checked) => setDraft({ ...draft, enabled: Boolean(checked) })}
          aria-label={`Enable ${rule.id} rule`}
        />
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="space-y-1 text-xs text-muted-foreground">
          <span>Metric</span>
          <Select
            value={draft.metric}
            onValueChange={(value) => {
              if (!METRICS.some((option) => option.value === value)) return;
              const metric = value as ResourceRule["metric"];
              const next: ResourceRule = {
                id: draft.id,
                enabled: draft.enabled,
                metric,
                scope: metric.startsWith("app") ? "core" : "host",
                sustainSeconds: draft.sustainSeconds,
                cooldownSeconds: draft.cooldownSeconds,
                ...(metric === "temperature"
                  ? {}
                  : {
                      threshold: metric === "appMemory" ? 4 * GIB : 95,
                      recovery: metric === "appMemory" ? 3 * GIB : 90,
                    }),
              };
              setDraft(next);
            }}
          >
            <SelectTrigger
              variant="muted-outline"
              className="w-full text-sm"
              aria-label={`Metric for ${rule.id}`}
            >
              <SelectValue>
                {METRICS.find((option) => option.value === draft.metric)?.label}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup alignItemWithTrigger={false}>
              {METRICS.map((option) => (
                <SelectItem hideIndicator key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
        <div className="space-y-1 text-xs text-muted-foreground">
          <span>Scope</span>
          <Select
            value={draft.scope}
            onValueChange={(value) => {
              if (value === "host" || value === "core" || value === "inclusive") {
                setDraft({ ...draft, scope: value });
              }
            }}
          >
            <SelectTrigger
              variant="muted-outline"
              className="w-full text-sm"
              aria-label={`Scope for ${rule.id}`}
            >
              <SelectValue>
                {draft.scope === "host"
                  ? "Host"
                  : draft.scope === "core"
                    ? "bigbud core"
                    : "bigbud inclusive"}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup alignItemWithTrigger={false}>
              {(draft.metric.startsWith("app") ? ["core", "inclusive"] : ["host"]).map((scope) => (
                <SelectItem hideIndicator key={scope} value={scope}>
                  {scope === "host"
                    ? "Host"
                    : scope === "core"
                      ? "bigbud core"
                      : "bigbud inclusive"}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
        {(draft.metric === "disk" || temperature) && (
          <label className="space-y-1 text-xs text-muted-foreground sm:col-span-2">
            {temperature ? "Sensor (blank for all)" : "Disk mount (blank for all)"}
            <Input
              value={draft.entity ?? ""}
              maxLength={128}
              onChange={(event) => setDraft({ ...draft, entity: event.target.value || undefined })}
            />
          </label>
        )}
        {numericFields.map((field) => (
          <label key={field} className="space-y-1 text-xs text-muted-foreground">
            {
              {
                threshold: `Warn at (${temperature ? "°C" : memory ? "GiB" : "%"})`,
                recovery: `Recover below (${temperature ? "°C" : memory ? "GiB" : "%"})`,
                sustainSeconds: "Duration (seconds)",
                cooldownSeconds: "Cooldown (seconds)",
                minimumFreeBytes: "Free space below (GiB)",
                recoveryFreeBytes: "Free space recovery (GiB)",
              }[field]
            }
            <Input
              type="number"
              min={0}
              step={field === "sustainSeconds" || field === "cooldownSeconds" ? 1 : "any"}
              value={fieldValue(draft, field)}
              placeholder={
                temperature && (field === "threshold" || field === "recovery")
                  ? "Hardware limit"
                  : undefined
              }
              onChange={(event) => updateNumber(field, event.target.value)}
            />
          </label>
        ))}
      </div>
      {temperature && draft.threshold === undefined && (
        <p className="text-xs text-muted-foreground">
          Uses the sensor’s reported critical temperature. Without one, this rule stays inactive.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" type="submit" disabled={pending}>
          Save rule
        </Button>
        <Button
          size="sm"
          type="button"
          variant="ghost"
          disabled={pending}
          onClick={() => void save(true)}
        >
          Delete
        </Button>
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
      </div>
    </form>
  );
}
