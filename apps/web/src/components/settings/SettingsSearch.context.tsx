import { createContext, type ReactNode, useContext, useMemo } from "react";

type SettingsSearchContextValue = {
  query: string;
  terms: ReadonlyArray<string>;
};

const SettingsSearchContext = createContext<SettingsSearchContextValue>({
  query: "",
  terms: [],
});

export function SettingsSearchProvider({
  query,
  terms,
  children,
}: SettingsSearchContextValue & { children: ReactNode }) {
  const value = useMemo(() => ({ query, terms }), [query, terms]);

  return <SettingsSearchContext.Provider value={value}>{children}</SettingsSearchContext.Provider>;
}

export function useSettingsSearch() {
  return useContext(SettingsSearchContext);
}
