import { type FormEvent } from "react";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { SCRIPT_ICONS, ScriptIcon } from "./ProjectScriptsControl.logic";

interface ProjectScriptsDialogProps {
  addScriptFormId: string;
  dialogOpen: boolean;
  editingScriptId: string | null;
  name: string;
  command: string;
  icon: (typeof SCRIPT_ICONS)[number]["id"];
  iconPickerOpen: boolean;
  runOnWorktreeCreate: boolean;
  keybinding: string;
  validationError: string | null;
  captureKeybinding: (event: React.KeyboardEvent<HTMLInputElement>) => void;
  onCommandChange: (value: string) => void;
  onDialogOpenChange: (open: boolean) => void;
  onDialogOpenChangeComplete: (open: boolean) => void;
  onIconChange: (value: (typeof SCRIPT_ICONS)[number]["id"]) => void;
  onIconPickerOpenChange: (open: boolean) => void;
  onKeybindingChange: (value: string) => void;
  onNameChange: (value: string) => void;
  onRequestDelete: () => void;
  onRunOnWorktreeCreateChange: (checked: boolean) => void;
  onSubmit: (event: FormEvent) => Promise<void> | void;
}

export function ProjectScriptsDialog({
  addScriptFormId,
  dialogOpen,
  editingScriptId,
  name,
  command,
  icon,
  iconPickerOpen,
  runOnWorktreeCreate,
  keybinding,
  validationError,
  captureKeybinding,
  onCommandChange,
  onDialogOpenChange,
  onDialogOpenChangeComplete,
  onIconChange,
  onIconPickerOpenChange,
  onKeybindingChange,
  onNameChange,
  onRequestDelete,
  onRunOnWorktreeCreateChange,
  onSubmit,
}: ProjectScriptsDialogProps) {
  const isEditing = editingScriptId !== null;

  return (
    <Dialog
      onOpenChange={onDialogOpenChange}
      onOpenChangeComplete={onDialogOpenChangeComplete}
      open={dialogOpen}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{isEditing ? "Edit Action" : "Add Action"}</DialogTitle>
          <DialogDescription>
            Actions are project-scoped commands you can run from the top bar or keybindings.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form id={addScriptFormId} className="space-y-4" onSubmit={onSubmit}>
            <div className="space-y-1.5">
              <Label htmlFor="script-name">Name</Label>
              <div className="flex items-center gap-2">
                <Popover onOpenChange={onIconPickerOpenChange} open={iconPickerOpen}>
                  <PopoverTrigger
                    render={
                      <Button
                        type="button"
                        variant="outline"
                        className="size-9 shrink-0 hover:bg-popover active:bg-popover data-pressed:bg-popover data-pressed:shadow-xs/5 data-pressed:before:shadow-[0_1px_--theme(--color-black/4%)] dark:data-pressed:before:shadow-[0_-1px_--theme(--color-white/6%)]"
                        aria-label="Choose icon"
                      />
                    }
                  >
                    <ScriptIcon icon={icon} className="size-4.5" />
                  </PopoverTrigger>
                  <PopoverPopup align="start">
                    <div className="grid grid-cols-3 gap-2">
                      {SCRIPT_ICONS.map((entry) => {
                        const isSelected = entry.id === icon;
                        return (
                          <button
                            key={entry.id}
                            type="button"
                            className={`relative flex flex-col items-center gap-2 rounded-md border px-2 py-2 text-xs ${
                              isSelected
                                ? "border-primary/70 bg-primary/10"
                                : "border-border/70 hover:bg-accent/60"
                            }`}
                            onClick={() => {
                              onIconChange(entry.id);
                              onIconPickerOpenChange(false);
                            }}
                          >
                            <ScriptIcon icon={entry.id} className="size-4" />
                            <span>{entry.label}</span>
                          </button>
                        );
                      })}
                    </div>
                  </PopoverPopup>
                </Popover>
                <Input
                  id="script-name"
                  autoFocus
                  placeholder="Test"
                  value={name}
                  onChange={(event) => onNameChange(event.target.value)}
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="script-keybinding">Keybinding</Label>
              <Input
                id="script-keybinding"
                placeholder="Press shortcut"
                value={keybinding}
                readOnly
                onChange={(event) => onKeybindingChange(event.target.value)}
                onKeyDown={captureKeybinding}
              />
              <p className="text-xs text-muted-foreground">
                Press a shortcut. Use <code>Backspace</code> to clear.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="script-command">Command</Label>
              <Textarea
                id="script-command"
                placeholder="bun test"
                value={command}
                onChange={(event) => onCommandChange(event.target.value)}
              />
            </div>
            <label className="flex items-center justify-between gap-3 rounded-md border border-border/70 px-3 py-2 text-sm">
              <span>Run automatically on worktree creation</span>
              <Switch
                checked={runOnWorktreeCreate}
                onCheckedChange={(checked) => onRunOnWorktreeCreateChange(Boolean(checked))}
              />
            </label>
            {validationError && <p className="text-sm text-destructive">{validationError}</p>}
          </form>
        </DialogPanel>
        <DialogFooter>
          {isEditing && (
            <Button
              type="button"
              variant="destructive-outline"
              className="mr-auto"
              onClick={onRequestDelete}
            >
              Delete
            </Button>
          )}
          <Button type="button" variant="outline" onClick={() => onDialogOpenChange(false)}>
            Cancel
          </Button>
          <Button form={addScriptFormId} type="submit">
            {isEditing ? "Save changes" : "Save action"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
