import {
  BIGBUD_TERMINAL_THEME,
  isTerminalThemeName,
  terminalThemeChoices,
} from "../terminal/terminalThemes";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "../ui/select";

const KIND_LABELS = { dark: "Dark themes", light: "Light themes" } as const;

/** Either slot may hold either kind of theme; the slot's own kind is listed first. */
export function TerminalThemeSelect(props: {
  kind: "dark" | "light";
  value: string;
  label: string;
  onChange: (name: string) => void;
}) {
  const kinds = props.kind === "dark" ? (["dark", "light"] as const) : (["light", "dark"] as const);
  const selected = isTerminalThemeName(props.value) ? props.value : BIGBUD_TERMINAL_THEME;
  return (
    <Select
      value={selected}
      onValueChange={(value) => {
        if (typeof value === "string" && isTerminalThemeName(value)) props.onChange(value);
      }}
    >
      <SelectTrigger variant="muted-outline" className="w-full sm:w-64" aria-label={props.label}>
        <SelectValue>
          {selected === BIGBUD_TERMINAL_THEME ? "bigbud (matches app)" : selected}
        </SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        <SelectItem hideIndicator value={BIGBUD_TERMINAL_THEME}>
          bigbud (matches app)
        </SelectItem>
        {kinds.map((kind) => (
          <SelectGroup key={kind}>
            <SelectSeparator />
            <SelectGroupLabel className="px-2 py-1 text-xs text-muted-foreground">
              {KIND_LABELS[kind]}
            </SelectGroupLabel>
            {terminalThemeChoices(kind).map((choice) => (
              <SelectItem hideIndicator key={choice.name} value={choice.name}>
                <span className="flex items-center gap-2">
                  <span
                    aria-hidden
                    className="inline-block size-3 shrink-0 rounded-sm border border-border"
                    style={{ background: choice.background }}
                  />
                  {choice.name}
                </span>
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectPopup>
    </Select>
  );
}
