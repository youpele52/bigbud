import { type ProjectCatalogScope } from "@bigbud/contracts/orchestration/orchestration.catalog";
import { queryOptions } from "@tanstack/react-query";

import { ensureNativeApi } from "~/rpc/nativeApi";

const PROJECT_CATALOG_SEARCH_LIMIT = 20;
const PROJECT_CATALOG_SEARCH_STALE_TIME = 15_000;

export const projectCatalogSearchQueryKeys = {
  all: ["project-catalog-search"] as const,
  query: (scope: ProjectCatalogScope, query: string) =>
    [...projectCatalogSearchQueryKeys.all, scope, query] as const,
};

export function projectCatalogSearchQueryOptions(input: {
  scope: ProjectCatalogScope;
  query: string;
  enabled: boolean;
}) {
  return queryOptions({
    queryKey: projectCatalogSearchQueryKeys.query(input.scope, input.query),
    queryFn: () =>
      ensureNativeApi().orchestration.getStartupProjectCatalog({
        scope: input.scope,
        query: input.query,
        limit: PROJECT_CATALOG_SEARCH_LIMIT,
      }),
    enabled: input.enabled && input.query.length > 0,
    staleTime: PROJECT_CATALOG_SEARCH_STALE_TIME,
  });
}
