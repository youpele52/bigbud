import { queryOptions, useQuery, type QueryClient } from "@tanstack/react-query";
import type {
  DesktopComputerUsePermissionsStatus,
  DesktopComputerUseRuntimeStatus,
} from "@bigbud/contracts";

export const desktopComputerUseQueryKeys = {
  all: ["desktop", "computer-use"] as const,
  status: () => ["desktop", "computer-use", "status"] as const,
  permissions: () => ["desktop", "computer-use", "permissions"] as const,
};

export const setDesktopComputerUseStatusQueryData = (
  queryClient: QueryClient,
  status: DesktopComputerUseRuntimeStatus | null,
) => queryClient.setQueryData(desktopComputerUseQueryKeys.status(), status);

export const setDesktopComputerUsePermissionsQueryData = (
  queryClient: QueryClient,
  status: DesktopComputerUsePermissionsStatus | null,
) => queryClient.setQueryData(desktopComputerUseQueryKeys.permissions(), status);

export function desktopComputerUseStatusQueryOptions() {
  return queryOptions({
    queryKey: desktopComputerUseQueryKeys.status(),
    queryFn: async () => {
      const bridge = window.desktopBridge;
      if (!bridge || typeof bridge.getComputerUseRuntimeStatus !== "function") return null;
      return bridge.getComputerUseRuntimeStatus();
    },
    staleTime: 5_000,
  });
}

export function desktopComputerUsePermissionsQueryOptions() {
  return queryOptions({
    queryKey: desktopComputerUseQueryKeys.permissions(),
    queryFn: async () => {
      const bridge = window.desktopBridge;
      if (!bridge || typeof bridge.getComputerUsePermissionsStatus !== "function") return null;
      return bridge.getComputerUsePermissionsStatus();
    },
    staleTime: 5_000,
  });
}

export function useDesktopComputerUseStatus(options?: { enabled?: boolean }) {
  return useQuery({
    ...desktopComputerUseStatusQueryOptions(),
    enabled: options?.enabled ?? true,
  });
}

export function useDesktopComputerUsePermissions(options?: { enabled?: boolean }) {
  return useQuery({
    ...desktopComputerUsePermissionsQueryOptions(),
    enabled: options?.enabled ?? true,
  });
}
