import { useItutuStore } from "../../stores/itutu/itutu.store";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group";

/** Switches the thread area between the Projects arrangement and Ìtútù. */
export function SidebarItutuArrangementSwitch() {
  const arrangement = useItutuStore((store) => store.arrangement);
  const setArrangement = useItutuStore((store) => store.setArrangement);
  return (
    <div className="px-2 pt-2">
      <ToggleGroup
        aria-label="Sidebar arrangement"
        className="w-full"
        variant="outline"
        size="sm"
        value={[arrangement]}
        onValueChange={(values) => {
          const next = values[0];
          if (next === "projects" || next === "itutu") setArrangement(next);
        }}
      >
        <ToggleGroupItem className="flex-1 text-xs" value="projects">
          Projects
        </ToggleGroupItem>
        <ToggleGroupItem className="flex-1 text-xs" value="itutu">
          Ìtútù
        </ToggleGroupItem>
      </ToggleGroup>
    </div>
  );
}
