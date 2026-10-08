import { Stack, Text } from '@mantine/core';
import { useState } from 'react';
import type { MarkdownPreviewRequest } from '../files/types';
import type { ImageLightboxImage } from '../images/types';
import { SubagentViewerView } from '../threads/SubagentViewerView';
import { TimelineView } from '../timeline/TimelineView';
import { LazyMarkdownContent } from '../timeline/rendererShared';
import { timelinePresentation } from './presentation';
import { nativeSubagentEntries, useNativeFork, type NativeSubagentList } from './useNativeSubagents';

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
  const fork = useNativeFork(chatId, selected?.kind === 'fork' ? selected.nativeId : null);
  const [scrollParent, setScrollParent] = useState<HTMLDivElement | null>(null);
  const failure = error ?? (selected?.kind === 'fork' ? fork.error : null);
  const text = invocation?.result ?? invocation?.activity?.textDelta ?? '';
  const timeline = fork.snapshot ? timelinePresentation(fork.snapshot, fork.isLoadingOlderHistory) : null;
  const loading = selected?.kind === 'fork' && !fork.snapshot && !fork.error;
  return <SubagentViewerView subagents={entries} selectedSubagentId={selected?.id ?? null} onSelectSubagent={onSelect}
    error={failure ? new Error(failure) : null} onReload={() => { onReload(); fork.retry(); }}
    hasMore={inventory?.history.hasOlder ?? false} loadingMore={loadingMore} onLoadMore={onLoadMore}
    isLoading={loading} timelinePhase={failure ? 'error' : loading ? 'loadingSnapshot' : 'streamingLive'} scrollRef={setScrollParent}>
    {invocation ? <Stack gap="xs">
      {invocation.task ? <Text size="sm">{invocation.task}</Text> : null}
      {invocation.activity?.toolCalls.map((tool, index) => <Text size="xs" key={index}>{tool.name}{tool.isError ? ' (error)' : ''}</Text>)}
      {text ? <LazyMarkdownContent fallbackText={text} text={text} onImageOpen={onImageOpen} onMarkdownOpen={onMarkdownOpen} /> : <Text size="sm" c="dimmed">{invocation.status === 'running' ? 'Waiting for native activity.' : 'No saved result is available.'}</Text>}
    </Stack> : timeline ? <TimelineView approvals={[]} imagePreviewUrlsByPath={{}} onApprovalDecision={() => {}} onImageOpen={onImageOpen}
      onMarkdownOpen={onMarkdownOpen} onLoadOlderHistory={fork.loadOlderHistory} onReady={() => {}} scrollParentElement={scrollParent}
      showDebug={showDebug} timeline={timeline} /> : null}
  </SubagentViewerView>;
}
