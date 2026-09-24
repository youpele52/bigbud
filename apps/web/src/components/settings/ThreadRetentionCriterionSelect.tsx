import type { ThreadRetentionAgeCriterion } from "@bigbud/contracts/core/settings.threadRetention";

import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

export function ThreadRetentionCriterionSelect(input: {
  readonly value: ThreadRetentionAgeCriterion;
  readonly onChange: (value: ThreadRetentionAgeCriterion) => void;
  readonly disabled?: boolean;
  readonly label: string;
}) {
  return (
    <Select
      value={input.value}
      disabled={input.disabled}
      onValueChange={(value) => {
        if (value === "created" || value === "last-conversation-activity") input.onChange(value);
      }}
    >
      <SelectTrigger variant="muted-outline" aria-label={input.label} className="w-full">
        <SelectValue>
          {input.value === "created" ? "Created" : "Last conversation activity"}
        </SelectValue>
      </SelectTrigger>
      <SelectPopup alignItemWithTrigger={false}>
        <SelectItem hideIndicator value="created">
          Created
        </SelectItem>
        <SelectItem hideIndicator value="last-conversation-activity">
          Last conversation activity
        </SelectItem>
      </SelectPopup>
    </Select>
  );
}
