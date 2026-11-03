import { useState } from "react";
import type { ResourceRule } from "@bigbud/contracts/system-monitor/awareness.ts";
import { mutateResourceAwareness } from "~/stores/resource-monitor/resourceAwareness.store";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

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
      setError(String(cause));
    } finally {
      setPending(false);
    }
  };
  return (
    <form
      className="flex flex-wrap items-end gap-3 rounded-md border p-3 text-sm"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={draft.enabled}
          onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
        />
        {rule.id}
      </label>
      <label>
        Metric
        <select
          className="block rounded border bg-background p-1 text-sm"
          value={draft.metric}
          onChange={(event) => {
            const metric = event.target.value as ResourceRule["metric"];
            const next = {
              ...draft,
              metric,
              scope: metric.startsWith("app") ? ("core" as const) : ("host" as const),
            };
            if (metric !== "disk") {
              delete next.minimumFreeBytes;
              delete next.recoveryFreeBytes;
            }
            if (metric !== "disk" && metric !== "temperature") delete next.entity;
            setDraft(next);
          }}
        >
          {["hostCpu", "hostMemory", "disk", "temperature", "appCpu", "appMemory"].map((metric) => (
            <option key={metric}>{metric}</option>
          ))}
        </select>
      </label>
      <label>
        Scope
        <select
          className="block rounded border bg-background p-1 text-sm"
          value={draft.scope}
          onChange={(event) =>
            setDraft({ ...draft, scope: event.target.value as ResourceRule["scope"] })
          }
        >
          {(draft.metric.startsWith("app") ? ["core", "inclusive"] : ["host"]).map((scope) => (
            <option key={scope}>{scope}</option>
          ))}
        </select>
      </label>
      {(draft.metric === "disk" || draft.metric === "temperature") && (
        <label>
          Mount / sensor (blank = all)
          <Input
            value={draft.entity ?? ""}
            maxLength={128}
            onChange={(event) => setDraft({ ...draft, entity: event.target.value || undefined })}
          />
        </label>
      )}
      {(
        [
          "threshold",
          "recovery",
          "sustainSeconds",
          "cooldownSeconds",
          ...(draft.metric === "disk" ? ["minimumFreeBytes", "recoveryFreeBytes"] : []),
        ] as const
      ).map((field) => (
        <label key={field} className="w-36">
          {field}
          <Input
            type="number"
            min={0}
            value={(draft[field as keyof ResourceRule] as number) ?? ""}
            onChange={(event) =>
              setDraft({
                ...draft,
                [field]: event.target.value === "" ? undefined : Number(event.target.value),
              })
            }
          />
        </label>
      ))}
      <Button type="submit" disabled={pending}>
        Save rule
      </Button>
      <Button
        type="button"
        variant="outline"
        disabled={pending}
        onClick={() => {
          void save(true);
        }}
      >
        Delete
      </Button>
      {error && (
        <p role="alert" className="w-full text-destructive">
          {error}
        </p>
      )}
    </form>
  );
}
