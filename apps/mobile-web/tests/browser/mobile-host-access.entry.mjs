import React, { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "../../src/App";
import "../../src/mobile.css";
const strict = new URL(location.href).searchParams.get("fixtureStrict") === "1";
const app = React.createElement(App);
createRoot(document.getElementById("root")).render(
  strict ? React.createElement(StrictMode, null, app) : app,
);
