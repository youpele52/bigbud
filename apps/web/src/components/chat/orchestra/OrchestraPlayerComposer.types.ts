import { type ComponentProps } from "react";

import { ProviderModelPicker } from "../provider/ProviderModelPicker";

export type ModelOptionsByProvider = ComponentProps<
  typeof ProviderModelPicker
>["modelOptionsByProvider"];
