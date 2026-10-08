import { useCallback } from 'react';
import { AutomationRunsView } from '../automations/AutomationRunsView';
import { mastraClient, type ChatClient } from './client';
import { useNativeSnapshots } from './useNativeSnapshots';

type RunsSnapshot = Awaited<ReturnType<ChatClient['watchAutomationRuns']>> extends AsyncIterable<infer T> ? T : never;
export function NativeAutomationRuns({ automationId }: { automationId: string }) {
  const watch = useCallback((signal: AbortSignal) => mastraClient.watchAutomationRuns({ id: automationId }, { signal }), [automationId]);
  const { snapshot, error, retry } = useNativeSnapshots<RunsSnapshot>(automationId, watch);
  return <AutomationRunsView
    rows={snapshot?.rows.map(run => ({
      id: run.id ?? `${run.scheduleId}:${run.scheduledFireAt}:${run.actualFireAt}:${run.runId ?? ''}`,
      label: run.outcome.charAt(0).toUpperCase() + run.outcome.slice(1).replaceAll('-', ' '),
      createdAt: new Date(run.actualFireAt).toISOString(), error: run.error,
      color: run.outcome === 'failed' || ('deliveryStatus' in run && run.deliveryStatus === 'failed') ? 'red' : 'gray',
      ...('deliveryStatus' in run && typeof run.deliveryStatus === 'string' ? { detail: run.deliveryStatus === 'success' ? 'Input accepted' : `Delivery: ${run.deliveryStatus}` } : {}),
    }))}
    error={error} isLoading={!snapshot && !error} onRefresh={retry}
    note="Delivery outcomes are recorded independently of model completion."
  />;
}
