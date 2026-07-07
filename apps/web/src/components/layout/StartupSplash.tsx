import { isElectron } from "../../config/env";
import { BigbudLoader } from "./BigbudLoader";

export function StartupSplash({ className = "" }: { className?: string }) {
  return (
    <div className={`relative h-screen min-h-screen ${className}`}>
      {isElectron ? <div className="drag-region absolute inset-x-0 top-0 h-[52px]" /> : null}
      <BigbudLoader className="h-screen min-h-screen" />
    </div>
  );
}
