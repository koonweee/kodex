import { useCallback, useEffect, useMemo, useState } from "react";

import type { Project } from "../api/client";
import { useAvailableExecutorIds, useExecutorRuntimes, useGatewayInstanceStorage } from "../api/GatewayClientContext";
import { currentKodexRoute, pushKodexRoute } from "../shell/browserRouting";
import type { KodexRoute } from "../shell/navigation";
import { catalogTargetKey } from "./catalogProjection";
import { useFederatedCatalogContext } from "./FederatedCatalogContext";
import { buildFederatedSidebarModel, resolveActionableCatalogExecutorIds } from "./federatedSidebarModel";

export function useFederatedSidebarController({
  executorId,
  moveNativePinned,
  moveNativeProject,
  onError,
  onShowWorkspace,
  setNativePinned,
}: {
  executorId: string;
  moveNativePinned: (threadId: string, beforeThreadId: string | null) => void;
  moveNativeProject: (projectId: string, beforeProjectId: string | null) => void;
  onError: (error: unknown) => void;
  onShowWorkspace: () => void;
  setNativePinned: (threadId: string, pinned: boolean) => void;
}) {
  const federation = useFederatedCatalogContext();
  const runtimes = useExecutorRuntimes();
  const availableExecutorIds = useAvailableExecutorIds();
  const storage = useGatewayInstanceStorage();
  const [executorFilter, setExecutorFilter] = useState<string | null>(null);
  const [lastExplicitExecutorId, setLastExplicitExecutorId] = useState<string | null>(
    () => storage?.getItem("federation:last-explicit-executor") ?? null,
  );
  const [projectSettings, setProjectSettings] = useState<{ executorId: string; project: Project } | null>(null);
  const [route, setRoute] = useState<KodexRoute>(() => currentKodexRoute());

  const actionableExecutorIds = useMemo(() => {
    if (!federation?.catalog || !availableExecutorIds) return availableExecutorIds;
    return resolveActionableCatalogExecutorIds(federation.catalog, federation.executors, availableExecutorIds);
  }, [availableExecutorIds, federation?.catalog, federation?.executors]);
  const routeModel = useMemo(
    () => federation?.catalog && availableExecutorIds && actionableExecutorIds
      ? buildFederatedSidebarModel(federation.catalog, availableExecutorIds, actionableExecutorIds)
      : null,
    [actionableExecutorIds, availableExecutorIds, federation?.catalog],
  );
  const model = useMemo(
    () => federation?.catalog && availableExecutorIds && actionableExecutorIds
      ? buildFederatedSidebarModel(federation.catalog, availableExecutorIds, actionableExecutorIds, executorFilter)
      : null,
    [actionableExecutorIds, availableExecutorIds, executorFilter, federation?.catalog],
  );
  const executorChoices = useMemo(
    () => federation?.catalog && actionableExecutorIds
      ? federation.catalog.executors
        .filter((entry) => actionableExecutorIds.has(entry.executorId))
        .map((entry) => ({ id: entry.executorId, name: entry.executorName }))
      : federation ? [] : undefined,
    [actionableExecutorIds, federation],
  );
  const preferredExecutorId = executorChoices?.some((choice) => choice.id === lastExplicitExecutorId)
    ? lastExplicitExecutorId
    : executorChoices?.find((choice) => choice.id === executorId)?.id ?? executorChoices?.[0]?.id ?? executorId;

  const archiveThread = useCallback((threadId: string, fallback: (threadId: string) => void) => {
    if (!federation) {
      fallback(threadId);
      return;
    }
    const target = model?.resolveTarget(threadId);
    const runtime = target ? runtimes?.get(target.executorId) : null;
    if (!target || !runtime || !actionableExecutorIds?.has(target.executorId)) {
      onError(new Error("Executor unavailable."));
      return;
    }
    void runtime.api.archiveThread(target.nativeId).then(() => federation.refresh()).catch(onError);
  }, [actionableExecutorIds, federation, model, onError, runtimes]);

  const setPinned = useCallback((threadId: string, pinned: boolean) => {
    if (!federation) {
      setNativePinned(threadId, pinned);
      return;
    }
    const target = model?.resolveTarget(threadId);
    const runtime = target ? runtimes?.get(target.executorId) : null;
    if (!target || !runtime || !actionableExecutorIds?.has(target.executorId)) {
      onError(new Error("Executor unavailable."));
      return;
    }
    void runtime.api.setThreadPinned(target.nativeId, pinned).then(() => federation.refresh()).catch(onError);
  }, [actionableExecutorIds, federation, model, onError, runtimes, setNativePinned]);

  const moveProject = useCallback((projectId: string, beforeProjectId: string | null) => {
    if (!federation) {
      moveNativeProject(projectId, beforeProjectId);
      return;
    }
    const item = model?.resolveTarget(projectId);
    const before = beforeProjectId ? model?.resolveTarget(beforeProjectId) ?? null : null;
    if (!item || !actionableExecutorIds?.has(item.executorId) || (before && !actionableExecutorIds?.has(before.executorId))) {
      onError(new Error("Executor unavailable."));
      return;
    }
    void federation.moveItem("project", item, before).catch(onError);
  }, [actionableExecutorIds, federation, model, moveNativeProject, onError]);

  const movePinned = useCallback((threadId: string, beforeThreadId: string | null) => {
    if (!federation) {
      moveNativePinned(threadId, beforeThreadId);
      return;
    }
    const item = model?.resolveTarget(threadId);
    const before = beforeThreadId ? model?.resolveTarget(beforeThreadId) ?? null : null;
    if (!item || !actionableExecutorIds?.has(item.executorId) || (before && !actionableExecutorIds?.has(before.executorId))) {
      onError(new Error("Executor unavailable."));
      return;
    }
    void federation.moveItem("pinned", item, before).catch(onError);
  }, [actionableExecutorIds, federation, model, moveNativePinned, onError]);

  const activateTarget = useCallback((target: { executorId: string; nativeId: string }, mode: "draft" | "thread") => {
    onShowWorkspace();
    const nextRoute: KodexRoute = {
      executorId: target.executorId,
      panel: null,
      projectId: null,
      threadId: mode === "thread" ? target.nativeId : null,
      view: "thread",
    };
    setProjectSettings(null);
    setRoute(nextRoute);
    pushKodexRoute(nextRoute);
  }, [onShowWorkspace]);

  const recordExecutorUsed = useCallback((usedExecutorId: string) => {
    setLastExplicitExecutorId(usedExecutorId);
    storage?.setItem("federation:last-explicit-executor", usedExecutorId);
  }, [storage]);

  const selectProject = useCallback((target: { executorId: string; nativeId: string }, projectKey: string) => {
    const project = routeModel?.projects.find((candidate) => candidate.id === projectKey);
    if (!project) return;
    const nextRoute: KodexRoute = {
      executorId: target.executorId,
      panel: null,
      projectId: target.nativeId,
      threadId: null,
      view: "project",
    };
    setProjectSettings(target.executorId === executorId
      ? null
      : { executorId: target.executorId, project: { ...project, id: target.nativeId } });
    setRoute(nextRoute);
    pushKodexRoute(nextRoute);
  }, [executorId, routeModel]);

  const closeProjectSettings = useCallback(() => {
    setProjectSettings(null);
    onShowWorkspace();
    setRoute(currentKodexRoute());
  }, [onShowWorkspace]);

  useEffect(() => {
    const applyRoute = () => {
      const nextRoute = currentKodexRoute();
      setRoute(nextRoute);
      if (nextRoute.view !== "project" || !nextRoute.projectId || !nextRoute.executorId || nextRoute.executorId === executorId) {
        setProjectSettings(null);
        return;
      }
      const key = catalogTargetKey({ executorId: nextRoute.executorId, nativeId: nextRoute.projectId });
      const project = routeModel?.projects.find((candidate) => candidate.id === key);
      setProjectSettings(project
        ? { executorId: nextRoute.executorId, project: { ...project, id: nextRoute.projectId } }
        : null);
    };
    applyRoute();
    window.addEventListener("popstate", applyRoute);
    return () => window.removeEventListener("popstate", applyRoute);
  }, [executorId, routeModel]);

  const routeExecutorId = route.executorId ?? executorId;
  return {
    activateTarget,
    archiveThread,
    closeProjectSettings,
    executorChoices,
    executorFilter,
    federation,
    federationMode: federation !== null,
    model,
    movePinned,
    moveProject,
    preferredExecutorId,
    projectSettings,
    projectSettingsActionable: projectSettings
      ? actionableExecutorIds?.has(projectSettings.executorId) === true
      : false,
    recordExecutorUsed,
    selectProject,
    selectedProjectKey: route.projectId
      ? catalogTargetKey({ executorId: routeExecutorId, nativeId: route.projectId })
      : null,
    selectedThreadKey: route.threadId
      ? catalogTargetKey({ executorId: routeExecutorId, nativeId: route.threadId })
      : null,
    setExecutorFilter,
    setPinned,
    runtimes,
  };
}
