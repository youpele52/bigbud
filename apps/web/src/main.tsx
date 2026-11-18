import React from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { createHashHistory, createBrowserHistory } from "@tanstack/react-router";

import "@xterm/xterm/css/xterm.css";
import "./index.css";

import { isElectron } from "./config/env";
import { getRouter } from "./config/router";
import { BackendScopeGate } from "./components/remote-backend/BackendScopeGate";
import { bootstrapBackendScope } from "./rpc/backendScope";

// Electron loads the app from a file-backed shell, so hash history avoids path resolution issues.
const history = isElectron ? createHashHistory() : createBrowserHistory();

const router = getRouter(history);

// A `?backend=<profileId>` window binds its remote owner before the first render; without the
// parameter this resolves immediately and the local backend behaves exactly as before.
void bootstrapBackendScope()
  .catch(() => undefined)
  .then(() => {
    ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
      <React.StrictMode>
        <BackendScopeGate>
          <RouterProvider router={router} />
        </BackendScopeGate>
      </React.StrictMode>,
    );
  });
