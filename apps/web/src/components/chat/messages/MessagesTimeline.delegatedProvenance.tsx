import type { ParsedDelegatedThreadProvenance } from "~/lib/terminalContext";
import { ActivityAccordion } from "../common/ActivityAccordion";
import { ACTIVITY_DETAIL_PRE_CLASS_NAME } from "../common/ActivityAccordion.styles";

export function MessagesTimelineDelegatedProvenance(props: {
  provenance: ParsedDelegatedThreadProvenance | null;
}) {
  if (!props.provenance) return null;

  return (
    <ActivityAccordion variant="compact" title="Delegation details" className="mb-2">
      <pre className={ACTIVITY_DETAIL_PRE_CLASS_NAME}>{props.provenance.body}</pre>
    </ActivityAccordion>
  );
}
