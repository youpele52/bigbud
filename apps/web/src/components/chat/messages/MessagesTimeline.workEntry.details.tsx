import { ActivityAccordion } from "../common/ActivityAccordion";
import type { ActivityAccordionControl } from "../common/ActivityAccordion.state";
import { ACTIVITY_DETAIL_PRE_CLASS_NAME } from "../common/ActivityAccordion.styles";

/**
 * Collapsed disclosure under a work entry heading with the full command and detail text.
 * Timeline rows pass a persisted `accordion`; standalone uses stay uncontrolled.
 */
export function WorkEntryDetails(props: {
  readonly blocks: ReadonlyArray<string>;
  readonly accordion?: ActivityAccordionControl | undefined;
}) {
  if (props.blocks.length === 0) return null;
  return (
    <ActivityAccordion
      variant="compact"
      title="Details"
      className="mt-0.5"
      panelClassName="space-y-1.5"
      data-work-entry-details=""
      {...props.accordion}
    >
      {props.blocks.map((block) => (
        <pre key={block} className={ACTIVITY_DETAIL_PRE_CLASS_NAME}>
          {block}
        </pre>
      ))}
    </ActivityAccordion>
  );
}
