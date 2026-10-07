import { Button, Center, MantineProvider, Stack, Text } from '@mantine/core';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import { InstanceStorageProvider } from '../api/GatewayInstanceBoundary';
import { createInstanceStorage } from '../api/instanceStorage';
import { mastraClient, type HostInfo } from './client';
import { errorMessageFrom } from '../shared/values';

const NativeHostContext = createContext<HostInfo | null>(null);
export function useNativeHost() {
  const info = useContext(NativeHostContext);
  if (!info) throw new Error('Native host has not connected');
  return info;
}
export function NativeHostBoundary({ children, queryClient }: { children: ReactNode; queryClient: QueryClient }) {
  const [info, setInfo] = useState<HostInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const lifetime = new AbortController();
    void mastraClient.info(undefined, { signal: lifetime.signal }).then(async next => {
      if (lifetime.signal.aborted) return;
      await queryClient.cancelQueries();
      queryClient.clear();
      setInfo(next); setError(null);
    }).catch(failure => { if (!lifetime.signal.aborted) setError(errorMessageFrom(failure)); });
    return () => lifetime.abort();
  }, [attempt, queryClient]);
  const storage = useMemo(() => info ? createInstanceStorage(info.instanceId) : null, [info?.instanceId]);
  if (!info) return <MantineProvider><Center mih="100vh"><Stack align="center"><Text role={error ? 'alert' : undefined}>{error ?? 'Connecting to Kodex…'}</Text>{error ? <Button onClick={() => setAttempt(value => value + 1)}>Retry connection</Button> : null}</Stack></Center></MantineProvider>;
  return <NativeHostContext.Provider value={info}><InstanceStorageProvider storage={storage}>{children}</InstanceStorageProvider></NativeHostContext.Provider>;
}
