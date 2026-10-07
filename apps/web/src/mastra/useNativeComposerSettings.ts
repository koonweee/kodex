import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ComposerModelChoice, ComposerSettings, ComposerSettingsChange } from '../ComposerFooterControls';
import { errorMessageFrom } from '../shared/values';
import { mastraClient, type ChatClient, type ChatSnapshot } from './client';
import { useNativeSnapshots } from './useNativeSnapshots';

type DraftDefaults = Awaited<ReturnType<ChatClient['getDraftDefaults']>>;
type SettingsPatch = Parameters<ChatClient['updateChatSettings']>[0]['patch'];

export function useNativeComposerSettings({ chatId, projectId, snapshot, onError }: {
  chatId: string | null; projectId: string | null; snapshot: ChatSnapshot | null; onError: (error: unknown) => void;
}) {
  const models = useQuery({ queryKey: ['mastra', 'models', projectId], enabled: projectId !== null,
    queryFn: () => mastraClient.listModels({ projectId: projectId! }), retry: false });
  const watchDefaults = useCallback((signal: AbortSignal) => mastraClient.watchDraftDefaults(undefined, { signal }), []);
  const defaults = useNativeSnapshots<DraftDefaults>(!chatId && projectId ? 'draft-defaults' : null, watchDefaults);
  const [drafts, setDrafts] = useState<Map<string | null, SettingsPatch>>(() => new Map());
  const [operation, setOperation] = useState<{ key: string; pending: boolean; error: string | null } | null>(null);
  const key = chatId ?? `draft:${projectId}`;
  const activeKey = useRef(key);
  activeKey.current = key;
  const lifetime = useRef(0);
  useEffect(() => { lifetime.current++; return () => { lifetime.current++; }; }, [key]);
  const localDraft = !chatId ? drafts.get(projectId) ?? null : null;
  const nativeSettings = chatId ? snapshot?.settings : defaults.snapshot;
  const modelId = localDraft?.modelId ?? nativeSettings?.modelId;
  const thinkingLevel = localDraft && 'thinkingLevel' in localDraft ? localDraft.thinkingLevel : nativeSettings?.thinkingLevel;
  const choices = useMemo<ComposerModelChoice[]>(() => (models.data ?? []).filter(model => model.hasApiKey).map(model => ({ id: model.id, model: model.modelName,
    supportedReasoningEfforts: (chatId && snapshot?.settings.modelId === model.id ? snapshot.settings.thinkingLevels : model.thinkingLevels).map(level => ({ reasoningEffort: level })),
  })), [models.data, chatId, snapshot?.settings.modelId, snapshot?.settings.thinkingLevels]);
  const fast = localDraft?.fast ?? (chatId ? snapshot?.settings.fast : false) ?? false;
  const settings: ComposerSettings | null = nativeSettings && modelId ? { model: modelId, effort: thinkingLevel ?? undefined, fast } : null;
  const pending = operation?.key === key && operation.pending;
  const error = operation?.key === key && operation.error || (models.error ? errorMessageFrom(models.error) : null) || (!chatId ? defaults.error : null);
  function fail(failure: unknown) {
    setOperation({ key, pending: false, error: errorMessageFrom(failure) });
    onError(failure);
  }
  function change(change: ComposerSettingsChange) {
    if (!settings || pending) return;
    const patch: SettingsPatch = {};
    if (change.fast !== undefined) patch.fast = change.fast;
    else if ('serviceTier' in change) patch.fast = change.serviceTier === 'fast';
    if (change.model !== undefined) patch.modelId = change.model;
    if (change.effort !== undefined) {
      const supported = (models.data ?? []).find(model => model.id === (patch.modelId ?? modelId))?.thinkingLevels ?? [];
      if (!supported.some(level => level === change.effort)) { fail(new Error('That thinking level is not supported by the selected model.')); return; }
      patch.thinkingLevel = supported.find(level => level === change.effort)!;
    }
    if (!Object.keys(patch).length) return;
    if (!chatId) {
      const selected = (models.data ?? []).find(model => model.id === (patch.modelId ?? modelId));
      const previous = localDraft && 'thinkingLevel' in localDraft ? localDraft.thinkingLevel : nativeSettings!.thinkingLevel;
      const supported = selected?.thinkingLevels ?? [];
      const level = 'thinkingLevel' in patch ? patch.thinkingLevel : previous != null && supported.includes(previous) ? previous : null;
      setDrafts(current => new Map(current).set(projectId, { modelId: patch.modelId ?? modelId!, thinkingLevel: level, fast: patch.fast ?? fast }));
      setOperation(null);
      return;
    }
    const generation = lifetime.current;
    setOperation({ key, pending: true, error: null });
    void mastraClient.updateChatSettings({ chatId, patch }).then(() => {
      // Canonical watchChat owns the displayed settings. A late acknowledgment
      // cannot replace another client's newer model or thinking-level change.
      if (activeKey.current === key && lifetime.current === generation) setOperation({ key, pending: false, error: null });
    }).catch(failure => {
      if (activeKey.current === key && lifetime.current === generation) fail(failure);
    });
  }
  return { models: choices, settings, pending: Boolean(pending), error: error || null, change, creationSettings: localDraft ?? undefined };
}
