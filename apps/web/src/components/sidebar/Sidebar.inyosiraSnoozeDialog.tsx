import { useEffect, useState } from "react";

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
import { snoozeThread } from "./Sidebar.inyosira.actions";
import {
  formatSnoozeWakeTime,
  parseSnoozeDuration,
  useInyosiraSnoozePickerStore,
} from "./Sidebar.inyosira.snoozePicker";

const inputClassName =
  "mt-1.5 flex border-border bg-card font-sans has-focus-visible:border-ring/45 has-focus-visible:ring-0";

/** Custom snooze duration for one thread. The server calculates the actual deadline. */
export function SidebarInyosiraSnoozeDialog() {
  const threadId = useInyosiraSnoozePickerStore((state) => state.threadId);
  const close = useInyosiraSnoozePickerStore((state) => state.close);
  const [value, setValue] = useState("");
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (threadId === null) return;
    setValue("");
    setTouched(false);
  }, [threadId]);

  const parsed = parseSnoozeDuration(value);
  const error = touched && !parsed.ok ? parsed.error : null;
  const submit = () => {
    setTouched(true);
    if (!parsed.ok || threadId === null) return;
    close();
    void snoozeThread(threadId, parsed.minutes);
  };

  return (
    <Dialog open={threadId !== null} onOpenChange={(open) => (open ? undefined : close())}>
      <DialogPopup className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Snooze thread</DialogTitle>
          <DialogDescription>
            The thread waits in Later and moves to Needs you when the snooze ends.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <label htmlFor="inyosira-snooze-duration" className="block">
            <span className="text-xs font-medium text-foreground">Duration</span>
            <Input
              id="inyosira-snooze-duration"
              autoFocus
              className={inputClassName}
              aria-invalid={error ? true : undefined}
              placeholder="45, 90m, 3h, or 1h 30m"
              spellCheck={false}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              onBlur={() => setTouched(value.trim() !== "")}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  submit();
                }
              }}
            />
            {error ? (
              <p role="alert" className="mt-1.5 text-destructive text-xs leading-4">
                {error}
              </p>
            ) : (
              <p className="mt-1.5 text-muted-foreground text-xs leading-4">
                {parsed.ok
                  ? `Wakes around ${formatSnoozeWakeTime(new Date(Date.now() + parsed.minutes * 60_000))}`
                  : "2 minutes to 24 hours."}
              </p>
            )}
          </label>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={close}>
            Cancel
          </Button>
          <Button size="sm" disabled={!parsed.ok} onClick={submit}>
            Snooze
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
