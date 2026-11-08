import { Layer } from "effect";
import type { TerminalManager } from "./terminal/Services/Manager.ts";

/** Bind at engine construction, including consumers built before runtime dependencies. */
export const withEngineTerminal = <A, E, R, E2, R2>(
  engine: Layer.Layer<A, E, R>,
  terminal: Layer.Layer<TerminalManager, E2, R2>,
) => engine.pipe(Layer.provide(terminal));
