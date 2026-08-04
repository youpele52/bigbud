import { MenuGroup, MenuRadioGroup, MenuRadioItem, MenuSeparator } from "../../ui/menu";

import {
  buildNextOptions,
  type TraitsPickerProviderOptions as ProviderOptions,
} from "./TraitsPicker.logic";

export function ClaudeWorkflowMenu(props: {
  readonly enabled: boolean;
  readonly modelOptions: ProviderOptions | null | undefined;
  readonly onModelOptionsChange: (options: ProviderOptions) => void;
}) {
  return (
    <>
      <MenuSeparator />
      <MenuGroup>
        <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Workflow</div>
        <MenuRadioGroup
          value={props.enabled ? "ultracode" : "standard"}
          onValueChange={(value) => {
            props.onModelOptionsChange(
              buildNextOptions("claudeAgent", props.modelOptions, {
                ultracode: value === "ultracode",
              }),
            );
          }}
        >
          <MenuRadioItem value="standard">Standard</MenuRadioItem>
          <MenuRadioItem value="ultracode">Ultracode</MenuRadioItem>
        </MenuRadioGroup>
      </MenuGroup>
    </>
  );
}
