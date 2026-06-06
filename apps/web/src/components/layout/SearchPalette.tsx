import { type ThreadId } from "@bigbud/contracts";

import { useSearchStore } from "../../stores/ui";
import { SearchPaletteDialogContent } from "./SearchPalette.content";

interface SearchPaletteProps {
  activeThreadId: ThreadId | null;
}

export function SearchPalette({ activeThreadId }: SearchPaletteProps) {
  const open = useSearchStore((store) => store.searchOpen);

  return open ? <SearchPaletteDialogContent activeThreadId={activeThreadId} /> : null;
}
