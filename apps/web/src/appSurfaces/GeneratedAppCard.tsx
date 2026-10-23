import { Alert, Box, Loader, Text } from "@mantine/core";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createContext, useContext, useCallback, type ReactNode } from "react";
import { getAppSurface, callAppSurfaceBridge, type AppSurfaceBridgeRequest, type GeneratedAppReference } from "../api/client";
import { queryKeys } from "../api/queryKeys";
import { useAppearancePreferences } from "../theme/useAppearancePreferences";
import { AppSurfacePane } from "./AppSurfacePane";

const InteractionContext = createContext(false);
export function GeneratedAppInteractionProvider({enabled,children}:{enabled:boolean;children:ReactNode}) {
  return <InteractionContext.Provider value={enabled}>{children}</InteractionContext.Provider>;
}
export function GeneratedAppCard({card}:{card:GeneratedAppReference}) {
  const enabled = useContext(InteractionContext);
  return <Box component="section" aria-label={card.title} className="kodex-generated-app-card">
    <Text fw={500} size="sm">{card.title}</Text>
    {enabled ? <InteractiveGeneratedApp card={card} /> : <Text size="sm">{card.fallbackContent}</Text>}
  </Box>;
}
function InteractiveGeneratedApp({card}:{card:GeneratedAppReference}) {
  const {resolvedSchemeId} = useAppearancePreferences();
  const query = useQuery({queryKey:queryKeys.generatedApp(card.id),queryFn:({signal})=>getAppSurface(card.id,signal),staleTime:Infinity,retry:false});
  const bridge = useMutation({mutationFn:(request:AppSurfaceBridgeRequest)=>callAppSurfaceBridge(card.id,request),retry:false});
  const mutate = bridge.mutateAsync;
  const onBridgeRequest = useCallback((request:AppSurfaceBridgeRequest)=>mutate(request),[mutate]);
  if (query.error) return <Alert role="alert" color="red">{card.fallbackContent}<Text size="xs">{query.error.message}</Text></Alert>;
  if (!query.data) return <><Loader size="xs"/><Text size="sm">{card.fallbackContent}</Text></>;
  return <><AppSurfacePane presentation="inline" colorSchemeId={resolvedSchemeId} isBridgePending={bridge.isPending} onBridgeRequest={onBridgeRequest} session={query.data}/>
    <Text className="kodex-generated-app-reset-note" size="xs">Inputs may reset when you scroll away.</Text></>;
}
