import type { ProjectScript, ResolvedKeybindingsConfig } from "@bigbud/contracts";
import { ChevronDownIcon, PlusIcon, SettingsIcon } from "lucide-react";
import React, { type FormEvent, useCallback, useMemo, useState } from "react";

import {
  keybindingValueForCommand,
  decodeProjectScriptKeybindingRule,
} from "~/lib/projectScriptKeybindings";
import {
  commandForProjectScript,
  nextProjectScriptId,
  primaryProjectScript,
} from "../../logic/project-scripts";
import { shortcutLabelForCommand } from "../../models/keybindings";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Group, GroupSeparator } from "../ui/group";
import { Menu, MenuItem, MenuPopup, MenuShortcut, MenuTrigger } from "../ui/menu";
import {
  keybindingFromEvent,
  NewProjectScriptInput,
  SCRIPT_ICONS,
  ScriptIcon,
} from "./ProjectScriptsControl.logic";
import { ProjectScriptsDialog } from "./ProjectScriptsControl.dialog";

export type { NewProjectScriptInput };

interface ProjectScriptsControlProps {
  scripts: ProjectScript[];
  keybindings: ResolvedKeybindingsConfig;
  preferredScriptId?: string | null;
  onRunScript: (script: ProjectScript) => void;
  onAddScript: (input: NewProjectScriptInput) => Promise<void> | void;
  onUpdateScript: (scriptId: string, input: NewProjectScriptInput) => Promise<void> | void;
  onDeleteScript: (scriptId: string) => Promise<void> | void;
}

export default function ProjectScriptsControl({
  scripts,
  keybindings,
  preferredScriptId = null,
  onRunScript,
  onAddScript,
  onUpdateScript,
  onDeleteScript,
}: ProjectScriptsControlProps) {
  const addScriptFormId = React.useId();
  const [editingScriptId, setEditingScriptId] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [icon, setIcon] = useState<(typeof SCRIPT_ICONS)[number]["id"]>("play");
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const [runOnWorktreeCreate, setRunOnWorktreeCreate] = useState(false);
  const [keybinding, setKeybinding] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);

  const primaryScript = useMemo(() => {
    if (preferredScriptId) {
      const preferred = scripts.find((script) => script.id === preferredScriptId);
      if (preferred) return preferred;
    }
    return primaryProjectScript(scripts);
  }, [preferredScriptId, scripts]);
  const dropdownItemClassName =
    "data-highlighted:bg-transparent data-highlighted:text-foreground hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground data-highlighted:hover:bg-accent data-highlighted:hover:text-accent-foreground data-highlighted:focus-visible:bg-accent data-highlighted:focus-visible:text-accent-foreground";

  const captureKeybinding = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Tab") return;
    event.preventDefault();
    if (event.key === "Backspace" || event.key === "Delete") {
      setKeybinding("");
      return;
    }
    const next = keybindingFromEvent(event);
    if (!next) return;
    setKeybinding(next);
  };

  const submitAddScript = async (event: FormEvent) => {
    event.preventDefault();
    const trimmedName = name.trim();
    const trimmedCommand = command.trim();
    if (trimmedName.length === 0) {
      setValidationError("Name is required.");
      return;
    }
    if (trimmedCommand.length === 0) {
      setValidationError("Command is required.");
      return;
    }

    setValidationError(null);
    try {
      const scriptIdForValidation =
        editingScriptId ??
        nextProjectScriptId(
          trimmedName,
          scripts.map((script) => script.id),
        );
      const keybindingRule = decodeProjectScriptKeybindingRule({
        keybinding,
        command: commandForProjectScript(scriptIdForValidation),
      });
      const payload = {
        name: trimmedName,
        command: trimmedCommand,
        icon,
        runOnWorktreeCreate,
        keybinding: keybindingRule?.key ?? null,
      } satisfies NewProjectScriptInput;
      if (editingScriptId) {
        await onUpdateScript(editingScriptId, payload);
      } else {
        await onAddScript(payload);
      }
      setDialogOpen(false);
      setIconPickerOpen(false);
    } catch (error) {
      setValidationError(error instanceof Error ? error.message : "Failed to save action.");
    }
  };

  const openAddDialog = () => {
    setEditingScriptId(null);
    setName("");
    setCommand("");
    setIcon("play");
    setIconPickerOpen(false);
    setRunOnWorktreeCreate(false);
    setKeybinding("");
    setValidationError(null);
    setDialogOpen(true);
  };

  const openEditDialog = (script: ProjectScript) => {
    setEditingScriptId(script.id);
    setName(script.name);
    setCommand(script.command);
    setIcon(script.icon);
    setIconPickerOpen(false);
    setRunOnWorktreeCreate(script.runOnWorktreeCreate);
    setKeybinding(keybindingValueForCommand(keybindings, commandForProjectScript(script.id)) ?? "");
    setValidationError(null);
    setDialogOpen(true);
  };

  const confirmDeleteScript = useCallback(() => {
    if (!editingScriptId) return;
    setDeleteConfirmOpen(false);
    setDialogOpen(false);
    void onDeleteScript(editingScriptId);
  }, [editingScriptId, onDeleteScript]);

  return (
    <>
      {primaryScript ? (
        <Group aria-label="Project scripts">
          <Button
            size="xs"
            variant="toolbar"
            onClick={() => onRunScript(primaryScript)}
            title={`Run ${primaryScript.name}`}
          >
            <ScriptIcon icon={primaryScript.icon} />
            <span className="sr-only @3xl/header-actions:not-sr-only @3xl/header-actions:ml-0.5">
              {primaryScript.name}
            </span>
          </Button>
          <GroupSeparator className="hidden @3xl/header-actions:block" />
          <Menu highlightItemOnHover={false}>
            <MenuTrigger
              render={<Button size="icon-xs" variant="toolbar" aria-label="Script actions" />}
            >
              <ChevronDownIcon className="size-4" />
            </MenuTrigger>
            <MenuPopup align="end">
              {scripts.map((script) => {
                const shortcutLabel = shortcutLabelForCommand(
                  keybindings,
                  commandForProjectScript(script.id),
                );
                return (
                  <MenuItem
                    key={script.id}
                    className={`group ${dropdownItemClassName}`}
                    onClick={() => onRunScript(script)}
                  >
                    <ScriptIcon icon={script.icon} className="size-4" />
                    <span className="truncate">
                      {script.runOnWorktreeCreate ? `${script.name} (setup)` : script.name}
                    </span>
                    <span className="relative ms-auto flex h-6 min-w-6 items-center justify-end">
                      {shortcutLabel && (
                        <MenuShortcut className="ms-0 transition-opacity group-hover:opacity-0 group-focus-visible:opacity-0">
                          {shortcutLabel}
                        </MenuShortcut>
                      )}
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        className="absolute right-0 top-1/2 size-6 -translate-y-1/2 opacity-0 pointer-events-none transition-opacity group-hover:opacity-100 group-hover:pointer-events-auto group-focus-visible:opacity-100 group-focus-visible:pointer-events-auto"
                        aria-label={`Edit ${script.name}`}
                        onPointerDown={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                        }}
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          openEditDialog(script);
                        }}
                      >
                        <SettingsIcon className="size-3.5" />
                      </Button>
                    </span>
                  </MenuItem>
                );
              })}
              <MenuItem className={dropdownItemClassName} onClick={openAddDialog}>
                <PlusIcon className="size-4" />
                Add action
              </MenuItem>
            </MenuPopup>
          </Menu>
        </Group>
      ) : (
        <Button size="xs" variant="toolbar" onClick={openAddDialog} title="Add action">
          <PlusIcon className="size-3.5" />
          <span className="sr-only @3xl/header-actions:not-sr-only @3xl/header-actions:ml-0.5">
            Add action
          </span>
        </Button>
      )}

      <ProjectScriptsDialog
        addScriptFormId={addScriptFormId}
        dialogOpen={dialogOpen}
        editingScriptId={editingScriptId}
        name={name}
        command={command}
        icon={icon}
        iconPickerOpen={iconPickerOpen}
        runOnWorktreeCreate={runOnWorktreeCreate}
        keybinding={keybinding}
        validationError={validationError}
        captureKeybinding={captureKeybinding}
        onCommandChange={setCommand}
        onDialogOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) {
            setIconPickerOpen(false);
          }
        }}
        onDialogOpenChangeComplete={(open) => {
          if (open) return;
          setEditingScriptId(null);
          setName("");
          setCommand("");
          setIcon(SCRIPT_ICONS[0]?.id ?? "play");
          setRunOnWorktreeCreate(false);
          setKeybinding("");
          setValidationError(null);
        }}
        onIconChange={setIcon}
        onIconPickerOpenChange={setIconPickerOpen}
        onKeybindingChange={setKeybinding}
        onNameChange={setName}
        onRequestDelete={() => setDeleteConfirmOpen(true)}
        onRunOnWorktreeCreateChange={setRunOnWorktreeCreate}
        onSubmit={submitAddScript}
      />

      <AlertDialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete action "{name}"?</AlertDialogTitle>
            <AlertDialogDescription>This action cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button variant="destructive" onClick={confirmDeleteScript}>
              Delete action
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
