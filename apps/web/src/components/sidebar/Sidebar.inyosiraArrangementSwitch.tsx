import { useInyosiraStore } from "../../stores/inyosira/inyosira.store";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group";

/** Switches the thread area between the Projects arrangement and Inyosira. */
export function SidebarInyosiraArrangementSwitch() {
  const arrangement = useInyosiraStore((store) => store.arrangement);
  const setArrangement = useInyosiraStore((store) => store.setArrangement);
  return (
    <div className="px-2 pt-2">
      <ToggleGroup
        aria-label="Sidebar arrangement"
        className="w-full"
        variant="toolbar"
        size="xs"
        value={[arrangement]}
        onValueChange={(values) => {
          const next = values[0];
          if (next === "projects" || next === "inyosira") setArrangement(next);
        }}
      >
        <ToggleGroupItem className="flex-1 text-sm sm:text-sm" value="projects">
          Projects
        </ToggleGroupItem>
        <ToggleGroupItem className="flex-1 text-sm sm:text-sm" value="inyosira">
          Inyosira
        </ToggleGroupItem>
      </ToggleGroup>
    </div>
  );
}
