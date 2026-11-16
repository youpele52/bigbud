import type { LocalSupervisorControl } from "./localSupervisorControl.ts";
import { scopeLocalSupervisorControl } from "./localSupervisorControl.scope.ts";
/** Keep commands/CAS on the original root while checking the finite backend ownership boundary. */
export function bindSetupControlOwner(
  control: LocalSupervisorControl,
  checkpoint: () => Promise<void>,
  signal: AbortSignal,
): LocalSupervisorControl {
  return scopeLocalSupervisorControl(
    {
      ...control,
      run: async (target, script, options) => {
        await checkpoint();
        const result = await control.run(target, script, options);
        await checkpoint();
        return result;
      },
      openControl: async (target) => {
        await checkpoint();
        const result = await control.openControl(target);
        await checkpoint();
        return result;
      },
    },
    signal,
  );
}
