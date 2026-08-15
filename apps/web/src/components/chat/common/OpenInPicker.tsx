import {
  EditorId,
  type ResolvedKeybindingsConfig,
  type TerminalApplicationId,
} from "@bigbud/contracts";
import { memo, useCallback, useEffect, useMemo } from "react";
import { isOpenFavoriteEditorShortcut, shortcutLabelForCommand } from "../../../models/keybindings";
import { usePreferredEditor } from "../../../models/editor";
import { ChevronDownIcon, FolderClosedIcon, TerminalIcon } from "lucide-react";
import { Button } from "../../ui/button";
import { Group, GroupSeparator } from "../../ui/group";
import { Menu, MenuItem, MenuPopup, MenuShortcut, MenuTrigger } from "../../ui/menu";
import {
  AntigravityIcon,
  CursorIcon,
  Icon,
  KiroIcon,
  TraeIcon,
  IntelliJIdeaIcon,
  VisualStudioCode,
  VisualStudioCodeInsiders,
  VSCodium,
  WindsurfIcon,
  Zed,
} from "../../Icons";
import { cn, isMacPlatform, isWindowsPlatform } from "~/lib/utils";
import { readNativeApi } from "../../../rpc/nativeApi";
import { toastManager } from "../../ui/toast";

const MONOCHROME_EDITOR_ICON_CLASS_NAME = "text-neutral-500";

type OpenInOption = {
  label: string;
  Icon: Icon;
  value: EditorId;
  iconClassName?: string;
};

type TerminalOption = {
  label: string;
  value: TerminalApplicationId;
};

const resolveOptions = (platform: string, availableEditors: ReadonlyArray<EditorId>) => {
  const baseOptions: ReadonlyArray<OpenInOption> = [
    {
      label: "Cursor",
      Icon: CursorIcon,
      value: "cursor",
      iconClassName: MONOCHROME_EDITOR_ICON_CLASS_NAME,
    },
    {
      label: "Trae",
      Icon: TraeIcon,
      value: "trae",
      iconClassName: MONOCHROME_EDITOR_ICON_CLASS_NAME,
    },
    {
      label: "VS Code",
      Icon: VisualStudioCode,
      value: "vscode",
    },
    {
      label: "VS Code Insiders",
      Icon: VisualStudioCodeInsiders,
      value: "vscode-insiders",
    },
    {
      label: "VSCodium",
      Icon: VSCodium,
      value: "vscodium",
    },
    {
      label: "Zed",
      Icon: Zed,
      value: "zed",
      iconClassName: MONOCHROME_EDITOR_ICON_CLASS_NAME,
    },
    {
      label: "Windsurf",
      Icon: WindsurfIcon,
      value: "windsurf",
    },
    {
      label: "Kiro",
      Icon: KiroIcon,
      value: "kiro",
    },
    {
      label: "Antigravity",
      Icon: AntigravityIcon,
      value: "antigravity",
    },
    {
      label: "IntelliJ IDEA",
      Icon: IntelliJIdeaIcon,
      value: "idea",
    },
    {
      label: isMacPlatform(platform)
        ? "Finder"
        : isWindowsPlatform(platform)
          ? "Explorer"
          : "Files",
      Icon: FolderClosedIcon,
      value: "file-manager",
    },
  ];
  return baseOptions.filter((option) => availableEditors.includes(option.value));
};

const TERMINAL_LABELS: Record<TerminalApplicationId, string> = {
  ghostty: "Ghostty",
  wezterm: "WezTerm",
  alacritty: "Alacritty",
  kitty: "kitty",
  "windows-terminal": "Windows Terminal",
  "gnome-terminal": "GNOME Terminal",
  konsole: "Konsole",
  "xfce4-terminal": "XFCE Terminal",
};

function resolveTerminalOptions(
  availableTerminals: ReadonlyArray<TerminalApplicationId>,
): ReadonlyArray<TerminalOption> {
  return availableTerminals.map((value) => ({ label: TERMINAL_LABELS[value], value }));
}

export const OpenInPicker = memo(function OpenInPicker({
  keybindings,
  availableEditors,
  availableTerminals,
  openInCwd,
}: {
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  availableTerminals: ReadonlyArray<TerminalApplicationId>;
  openInCwd: string | null;
}) {
  const [preferredEditor, setPreferredEditor] = usePreferredEditor(availableEditors);
  const options = useMemo(
    () => resolveOptions(navigator.platform, availableEditors),
    [availableEditors],
  );
  const primaryOption = options.find(({ value }) => value === preferredEditor) ?? null;
  const terminals = useMemo(() => resolveTerminalOptions(availableTerminals), [availableTerminals]);

  const openInEditor = useCallback(
    (editorId: EditorId | null) => {
      const api = readNativeApi();
      if (!api || !openInCwd) return;
      const editor = editorId ?? preferredEditor;
      if (!editor) return;
      void api.shell.openInEditor(openInCwd, editor).then(
        () => setPreferredEditor(editor),
        () => toastManager.add({ type: "error", title: `Unable to open ${editor}` }),
      );
    },
    [preferredEditor, openInCwd, setPreferredEditor],
  );

  const openInTerminal = useCallback(
    (terminal: TerminalApplicationId) => {
      const api = readNativeApi();
      if (!api || !openInCwd) return;
      void api.shell
        .openInTerminal(openInCwd, terminal)
        .catch(() =>
          toastManager.add({ type: "error", title: `Unable to open ${TERMINAL_LABELS[terminal]}` }),
        );
    },
    [openInCwd],
  );

  const openFavoriteEditorShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "editor.openFavorite"),
    [keybindings],
  );

  useEffect(() => {
    const handler = (e: globalThis.KeyboardEvent) => {
      const api = readNativeApi();
      if (!isOpenFavoriteEditorShortcut(e, keybindings)) return;
      if (!api || !openInCwd) return;
      if (!preferredEditor) return;

      e.preventDefault();
      void api.shell
        .openInEditor(openInCwd, preferredEditor)
        .catch(() =>
          toastManager.add({ type: "error", title: `Unable to open ${preferredEditor}` }),
        );
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [preferredEditor, keybindings, openInCwd]);

  return (
    <Group aria-label="Subscription actions">
      <Button
        size="xs"
        variant="toolbar"
        disabled={!preferredEditor || !openInCwd}
        onClick={() => openInEditor(preferredEditor)}
      >
        {primaryOption?.Icon && (
          <primaryOption.Icon
            aria-hidden="true"
            className={cn("size-3.5", primaryOption.iconClassName)}
          />
        )}
        <span className="sr-only @3xl/header-actions:not-sr-only @3xl/header-actions:ml-0.5">
          Open
        </span>
      </Button>
      <GroupSeparator className="hidden @3xl/header-actions:block" />
      <Menu>
        <MenuTrigger render={<Button aria-label="Copy options" size="icon-xs" variant="toolbar" />}>
          <ChevronDownIcon aria-hidden="true" className="size-4" />
        </MenuTrigger>
        <MenuPopup align="end">
          {options.length === 0 && terminals.length === 0 && (
            <MenuItem disabled>No installed applications found</MenuItem>
          )}
          {options.map(({ label, Icon, value, iconClassName }) => (
            <MenuItem key={value} onClick={() => openInEditor(value)}>
              <Icon aria-hidden="true" className={cn(iconClassName ?? "text-muted-foreground")} />
              {label}
              {value === preferredEditor && openFavoriteEditorShortcutLabel && (
                <MenuShortcut>{openFavoriteEditorShortcutLabel}</MenuShortcut>
              )}
            </MenuItem>
          ))}
          {terminals.length > 0 && options.length > 0 && <div className="my-1 h-px bg-border" />}
          {terminals.map(({ label, value }) => (
            <MenuItem key={value} onClick={() => openInTerminal(value)}>
              <TerminalIcon aria-hidden="true" className="text-muted-foreground" />
              {label}
            </MenuItem>
          ))}
        </MenuPopup>
      </Menu>
    </Group>
  );
});
