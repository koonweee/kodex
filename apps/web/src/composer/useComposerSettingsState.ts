import { useRef, useState } from "react";

import {
  getComposerSettings,
  listModels,
  persistComposerSettings,
  type ModelSummary,
  type ThreadSummary,
} from "../api/client";
import type { ComposerSettings } from "../ComposerFooterControls";
import { errorMessageFrom } from "../shared/values";
import {
  composerSettingsFromThread,
  DEFAULT_COMPOSER_SETTINGS,
  mergeDurableComposerSettings,
  normalizePersistedComposerSettings,
} from "./settings";

type UseComposerSettingsStateParams = {
  onError: (error: unknown) => void;
  draftChatThreadSelected: boolean;
  selectedProjectId: string | null;
  selectedThread: ThreadSummary | null;
};

export function useComposerSettingsState({
  onError,
  draftChatThreadSelected,
  selectedProjectId,
  selectedThread,
}: UseComposerSettingsStateParams) {
  const [models, setModels] = useState<ModelSummary[]>([]);
  const [composerDefaults, setComposerDefaults] = useState<ComposerSettings>(DEFAULT_COMPOSER_SETTINGS);
  const [globalComposerDefaults, setGlobalComposerDefaults] = useState<ComposerSettings>(DEFAULT_COMPOSER_SETTINGS);
  const [draftComposerSettings, setDraftComposerSettings] = useState<ComposerSettings>(DEFAULT_COMPOSER_SETTINGS);
  const [threadComposerSettingsById, setThreadComposerSettingsById] = useState<Record<string, ComposerSettings>>({});
  const [composerSettingsError, setComposerSettingsError] = useState<string | null>(null);
  const draftComposerEditedRef = useRef(false);

  const selectedThreadSettings = selectedThread
    ? threadComposerSettingsById[selectedThread.id] ?? composerSettingsFromThread(selectedThread)
    : null;
  const composerSettings = selectedThread
    ? selectedThreadSettings ?? (selectedProjectId === null ? globalComposerDefaults : draftComposerSettings)
    : draftChatThreadSelected && !draftComposerEditedRef.current
      ? globalComposerDefaults
      : draftComposerSettings;

  async function hydrateComposerDefaults(projectId: string | null): Promise<ComposerSettings | null> {
    try {
      const nextModels = await listModels();
      setModels(nextModels);
      const settings = await getComposerSettings(projectId);
      const normalized = normalizePersistedComposerSettings(settings, nextModels);
      setComposerDefaults(normalized);
      if (projectId === null) {
        setGlobalComposerDefaults(normalized);
      }
      if (!draftComposerEditedRef.current) {
        setDraftComposerSettings(normalized);
      }
      return normalized;
    } catch (error) {
      if (models.length === 0) {
        try {
          setModels(await listModels());
        } catch (modelsError) {
          onError(modelsError);
        }
      }
      return null;
    }
  }

  function handleComposerSettingsChange(nextSettings: ComposerSettings) {
    const previousSettings = composerSettings;
    if (selectedThread) {
      setThreadComposerSettingsById((current) => ({ ...current, [selectedThread.id]: nextSettings }));
    } else {
      draftComposerEditedRef.current = true;
      setDraftComposerSettings(nextSettings);
    }
    persistDurableComposerSettings(previousSettings, nextSettings);
  }

  function applyThreadComposerSettings(thread: ThreadSummary) {
    const threadSettings = composerSettingsFromThread(thread);
    if (threadSettings) {
      setThreadComposerSettingsById((current) => ({ ...current, [thread.id]: threadSettings }));
    }
  }

  function persistDurableComposerSettings(previousSettings: ComposerSettings, nextSettings: ComposerSettings) {
    const patch: Parameters<typeof persistComposerSettings>[0] = {};
    if (previousSettings.model !== nextSettings.model) {
      patch.model = nextSettings.model ?? null;
    }
    if (previousSettings.effort !== nextSettings.effort) {
      patch.effort = nextSettings.effort ?? null;
    }
    if (previousSettings.fast !== nextSettings.fast) {
      patch.serviceTier = nextSettings.fast ? "fast" : null;
    }

    if (Object.keys(patch).length === 0) {
      return;
    }

    setComposerSettingsError(null);
    void persistComposerSettings(patch)
      .then(() => {
        setComposerDefaults((current) => mergeDurableComposerSettings(current, patch));
      })
      .catch((error) => {
        setComposerSettingsError(`Composer settings were not saved: ${errorMessageFrom(error)}`);
      });
  }

  return {
    applyThreadComposerSettings,
    composerSettings,
    composerSettingsError,
    draftComposerEditedRef,
    handleComposerSettingsChange,
    hydrateComposerDefaults,
    models,
  };
}
