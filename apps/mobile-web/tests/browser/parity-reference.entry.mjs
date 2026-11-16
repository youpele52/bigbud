import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { MobileParityReference } from "../../src/test-fixtures/MobileParityReference.tsx";
import "../../src/mobile.css";

const params = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");
const queryClient = new QueryClient({
  defaultOptions: { queries: { enabled: false, retry: false } },
});
let content;
if (params.get("client") === "desktop" && params.get("surface") === "shell") {
  content = createElement(
    (await import("./desktop-shell-reference/DesktopShellReference.tsx")).DesktopShellReference,
  );
} else if (params.get("client") === "desktop" && params.get("surface") === "work-entry-details") {
  content = createElement(
    (await import("./desktop-shell-reference/DesktopWorkEntryReference.tsx"))
      .DesktopWorkEntryReference,
  );
} else {
  content = createElement(MobileParityReference, {
    client: params.get("client") === "desktop" ? "desktop" : "mobile",
    surface: params.get("surface") ?? "loading",
  });
}
createRoot(document.getElementById("root")).render(
  createElement(QueryClientProvider, { client: queryClient }, content),
);
