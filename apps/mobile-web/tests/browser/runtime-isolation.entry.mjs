import { createElement, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MobileRuntimeIsolationFixture } from "../../src/test-fixtures/MobileRuntimeIsolation.fixture.tsx";
import "../../src/mobile.css";

const fixture = createElement(MobileRuntimeIsolationFixture);
createRoot(document.getElementById("root")).render(
  new URLSearchParams(location.search).get("strict") === "1"
    ? createElement(StrictMode, null, fixture)
    : fixture,
);
