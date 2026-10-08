import { AsyncQuestionAnswersProvider } from '../composer/AsyncQuestionReplyProvider';
import { Stack, Text } from '@mantine/core';
import { useState } from 'react';
import type { MarkdownPreviewRequest } from '../files/types';
import type { ImageLightboxImage } from '../images/types';
import { SubagentViewerView } from '../threads/SubagentViewerView';
import { TimelineView } from '../timeline/TimelineView';
import { LazyMarkdownContent } from '../timeline/rendererShared';
import { timelinePresentation } from './presentation';
import { nativeSubagentEntries, useNativeSubagentHistory, type NativeSubagentList } from './useNativeSubagents';

export function NativeSubagentViewer({ chatId, inventory, selectedId, onSelect, error, onReload, loadingMore, onLoadMore, onImageOpen, onMarkdownOpen, showDebug }: {
  chatId: string;
  inventory: NativeSubagentList | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
  error: string | null;
  onReload: () => void;
  loadingMore: boolean;
  onLoadMore: () => void;
  onImageOpen: (image: ImageLightboxImage) => void;
  onMarkdownOpen?: (request: MarkdownPreviewRequest) => void;
  showDebug: boolean;
}) {
  const entries = nativeSubagentEntries(inventory);
  const selected = entries.find(entry => entry.id === selectedId) ?? entries[0] ?? null;
  const invocation = selected?.kind === 'invocation' ? inventory?.invocations.find(item => item.id === selected.nativeId) : null;
  const history = useNativeSubagentHistory(chatId, selected && selected.kind !== 'invocation' ? { kind: selected.kind, id: selected.nativeId } : null);
  const viewingHistory = selected !== null && selected.kind !== 'invocation';
  const [scrollParent, setScrollParent] = useState<HTMLDivElement | null>(null);
  const failure = error ?? (viewingHistory ? history.error : null);
  const text = invocation?.result ?? invocation?.activity?.textDelta ?? '';
  // Inventory and child history share a root revision but arrive independently.
  const prompts = selected?.kind === 'child' && inventory && history.snapshot
    && inventory.epoch === history.snapshot.epoch && inventory.revision >= history.snapshot.revision
    ? inventory.childPrompts.filter(entry => entry.prompt.target?.threadId === selected.nativeId).map(entry => entry.prompt) : undefined;
  const timeline = history.snapshot ? timelinePresentation({ ...history.snapshot, prompts }, history.isLoadingOlderHistory) : null;
  const loading = viewingHistory && !history.snapshot && !history.error;
  return <SubagentViewerView subagents={entries} selectedSubagentId={selected?.id ?? null} onSelectSubagent={onSelect}
    error={failure ? new Error(failure) : null} onReload={() => { onReload(); history.retry(); }}
    hasMore={inventory?.history.hasOlder ?? false} loadingMore={loadingMore} onLoadMore={onLoadMore}
    isLoading={loading} timelinePhase={failure ? 'error' : loading ? 'loadingSnapshot' : 'streamingLive'} scrollRef={setScrollParent}>
    {invocation ? <Stack gap="xs">
      {invocation.task ? <Text size="sm">{invocation.task}</Text> : null}
      {invocation.activity?.toolCalls.map((tool, index) => <Text size="xs" key={index}>{tool.name}{tool.isError ? ' (error)' : ''}</Text>)}
      {text ? <LazyMarkdownContent fallbackText={text} text={text} onImageOpen={onImageOpen} onMarkdownOpen={onMarkdownOpen} /> : <Text size="sm" c="dimmed">{invocation.status === 'running' ? 'Waiting for native activity.' : 'No saved result is available.'}</Text>}
    </Stack> : timeline ? <AsyncQuestionAnswersProvider items={timeline.rows.flatMap(row => row.type === 'item' ? [row.item] : [])}><TimelineView approvals={[]} imagePreviewUrlsByPath={{}} onApprovalDecision={() => {}} onImageOpen={onImageOpen}
      onMarkdownOpen={onMarkdownOpen} onLoadOlderHistory={history.loadOlderHistory} onReady={() => {}} scrollParentElement={scrollParent}
      showDebug={showDebug} timeline={timeline} /></AsyncQuestionAnswersProvider> : null}
  </SubagentViewerView>;
}
