import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent as ReactChangeEvent,
  type ClipboardEvent as ReactClipboardEvent,
  type DragEvent as ReactDragEvent,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { refreshQueuedInputs } from "../queuedInputs/cache";

import {
  compactThread,
  createQueuedInput,
  interruptCurrentTurn,
  submitThreadInput,
  type ImageUpload,
  type TextElement,
  type TimelineFileAttachment,
  type TimelineSkillMention,
  type UserInput,
} from "../api/client";
import type { ComposerSettings } from "../ComposerFooterControls";
import { sameComposerContext, type ComposerContext } from "./settings";
import { slashCommandFromSubmittedText } from "./slashCommands";
import {
  createObjectUrl,
  filesFromDataTransfer,
  hasFiles,
  revokeObjectUrl,
} from "./attachmentUtils";
import type { ComposerDraftControls } from "./ComposerPanel";
import { isTouchInputDevice } from "../shared/inputCapabilities";
import { createClientRequestId } from "../shared/id";
import type { PendingAttachment } from "./types";
import { buildTurnPayload, type ComposerUploads } from "./buildTurnPayload";

type DraftThreadCreateRequest = { composerSettings?: ComposerSettings; firstMessageText: string; projectId?: string };
type DraftThreadCreateResult = { threadId: string };

type UseComposerOrchestrationParams = {
  activeSelectedTurnId: string | null;
  isRunning?: boolean;
  commands?: {
    send: (threadId: string, input: UserInput[], attachments: TimelineFileAttachment[], images: ImageUpload[]) => Promise<unknown>;
    queue: (threadId: string, input: UserInput[], attachments: TimelineFileAttachment[], images: ImageUpload[]) => Promise<unknown>;
    stop: (threadId: string) => Promise<unknown>;
    compact: (threadId: string) => Promise<unknown>;
    uploads: ComposerUploads;
  };
  activeSelectedTurnIdOverrideRef?: { current: string | null | undefined };
  canCompose: boolean;
  canComposeOverrideRef?: { current: boolean | undefined };
  composerSettings: ComposerSettings;
  draftChatThreadSelected: boolean;
  draftThreadProjectId: string | null;
  isDraftThreadSelected: boolean;
  onCreateDraftThread: (request: DraftThreadCreateRequest) => Promise<DraftThreadCreateResult>;
  onError: (error: unknown) => void;
  onOptimisticUserMessageRemoved?: (clientRequestId: string) => void;
  onOptimisticUserMessageSent?: (clientRequestId: string) => void;
  onOptimisticUserMessageStarted?: (message: {
    clientRequestId: string;
    skillMentions: TimelineSkillMention[];
    text: string;
    threadId: string;
  }) => void;
  onImagePreviewUrlsChanged?: (previewUrls: Record<string, string>) => void;
  onThreadMaterialized: (threadId: string) => void;
  onThreadTurnStartFailed: (threadId: string) => void;
  onThreadTurnStarted: (threadId: string) => void;
  selectedProjectId: string | null;
  selectedThreadId: string | null;
};

export function useComposerOrchestration({
  activeSelectedTurnId,
  isRunning,
  commands,
  activeSelectedTurnIdOverrideRef,
  canCompose,
  canComposeOverrideRef,
  composerSettings,
  draftChatThreadSelected,
  draftThreadProjectId,
  isDraftThreadSelected,
  onCreateDraftThread,
  onError,
  onOptimisticUserMessageRemoved,
  onOptimisticUserMessageSent,
  onOptimisticUserMessageStarted,
  onImagePreviewUrlsChanged,
  onThreadMaterialized,
  onThreadTurnStartFailed,
  onThreadTurnStarted,
  selectedProjectId,
  selectedThreadId,
}: UseComposerOrchestrationParams) {
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [isComposerSubmitting, setIsComposerSubmitting] = useState(false);
  const [isComposerDragActive, setIsComposerDragActive] = useState(false);
  const [imagePreviewUrlsByPath, setImagePreviewUrlsByPath] = useState<Record<string, string>>({});
  const attachmentInputRef = useRef<HTMLInputElement | null>(null);
  const composerContextRef = useRef<ComposerContext | null>(null);
  const latestComposerContextRef = useRef<ComposerContext | null>(null);
  const imagePreviewUrlsByPathRef = useRef<Record<string, string>>({});
  const isComposerSubmittingRef = useRef(isComposerSubmitting);
  const nextAttachmentId = useRef(0);
  const queryClient = useQueryClient();

  useEffect(() => {
    isComposerSubmittingRef.current = isComposerSubmitting;
  }, [isComposerSubmitting]);

  useEffect(() => {
    const nextContext = { activeSelectedTurnId, draftChatThreadSelected, draftThreadProjectId, selectedProjectId, selectedThreadId };
    const previousContext = composerContextRef.current;
    composerContextRef.current = nextContext;
    latestComposerContextRef.current = nextContext;
    if (
      previousContext &&
      previousContext.draftChatThreadSelected === draftChatThreadSelected &&
      previousContext.draftThreadProjectId === draftThreadProjectId &&
      previousContext.selectedProjectId === selectedProjectId &&
      previousContext.selectedThreadId === selectedThreadId
    ) {
      return;
    }
    if (isComposerSubmittingRef.current || (previousContext && !previousContext.selectedThreadId && !selectedThreadId)) {
      return;
    }

    clearPendingAttachments();
  }, [activeSelectedTurnId, draftChatThreadSelected, draftThreadProjectId, selectedProjectId, selectedThreadId]);

  async function handleSubmitTurn(
    event: FormEvent,
    composerText: string,
    draftControls: ComposerDraftControls,
    skillInputs: UserInput[] = [],
    skillTextElements: TextElement[] = [],
    skillMentions: TimelineSkillMention[] = [],
  ) {
    event.preventDefault();
    const submitter = "submitter" in event.nativeEvent ? event.nativeEvent.submitter : null;
    const queueRequested = submitter instanceof HTMLElement && submitter.dataset.submitIntent === "queue";
    const canSubmitComposer =
      currentCanCompose() &&
      !isComposerSubmitting &&
      (Boolean(composerText.trim()) || pendingAttachments.length > 0);
    if (!canSubmitComposer) {
      return;
    }

    const effectiveActiveSelectedTurnId = currentActiveSelectedTurnId();
    const text = composerText.trim();
    const slashCommand = slashCommandFromSubmittedText(text);
    if (slashCommand === "unknown") {
      onError(new Error(`Unknown command: ${text}`));
      return;
    }
    if (slashCommand === "compact") {
      if (!selectedThreadId) {
        onError(new Error("/compact is only available in a selected thread"));
        return;
      }
      if (pendingAttachments.length > 0) {
        onError(new Error("/compact does not support attachments"));
        return;
      }
      setIsComposerSubmitting(true);
      try {
        if (commands) await commands.compact(selectedThreadId);
        else await compactThread(selectedThreadId);
        draftControls.clearText();
        clearPendingAttachments();
      } catch (error) {
        onError(error);
      } finally {
        setIsComposerSubmitting(false);
      }
      return;
    }

    const clientUserMessageId = createClientRequestId();
    const attachments = pendingAttachments;
    let startedThreadId: string | null = null;
    let optimisticClientRequestId: string | null = null;
    let retryRestoreContext: ComposerContext = {
      activeSelectedTurnId: effectiveActiveSelectedTurnId,
      draftChatThreadSelected,
      draftThreadProjectId,
      selectedProjectId,
      selectedThreadId,
    };
    setIsComposerSubmitting(true);
    try {
      if (selectedThreadId) {
        draftControls.clearText();
        const payload = await buildTurnPayload({
          uploads: commands?.uploads,
          threadId: selectedThreadId, text, attachments, skillInputs, skillTextElements,
          updateAttachments, rememberImagePreviewUrls,
        });
        if (queueRequested) {
          try {
            if (commands) await commands.queue(selectedThreadId, payload.input, payload.attachments, payload.images);
            else await createQueuedInput(selectedThreadId, payload.input, payload.attachments, clientUserMessageId);
          } finally {
            if (!commands) void refreshQueuedInputs(queryClient, selectedThreadId);
          }
          clearPendingAttachments();
          setIsComposerSubmitting(false);
          return;
        }

        if (text && attachments.length === 0) {
          optimisticClientRequestId = clientUserMessageId;
          onOptimisticUserMessageStarted?.({
            clientRequestId: clientUserMessageId,
            skillMentions,
            text,
            threadId: selectedThreadId,
          });
        }
        if (commands) {
          await commands.send(selectedThreadId, payload.input, payload.attachments, payload.images);
        } else {
          const result = await submitThreadInput(selectedThreadId, payload.input, payload.attachments, clientUserMessageId, true);
          if (result.disposition === "queued") {
            if (optimisticClientRequestId) onOptimisticUserMessageRemoved?.(optimisticClientRequestId);
            void refreshQueuedInputs(queryClient, selectedThreadId);
            clearPendingAttachments();
            setIsComposerSubmitting(false);
            return;
          }
        }
        startedThreadId = selectedThreadId;
        onThreadTurnStarted(selectedThreadId);
        if (optimisticClientRequestId) {
          onOptimisticUserMessageSent?.(optimisticClientRequestId);
        }
        onThreadMaterialized(selectedThreadId);
        clearPendingAttachments();
        setIsComposerSubmitting(false);
        return;
      }

      if (!isDraftThreadSelected || (!draftChatThreadSelected && !selectedProjectId)) {
        setIsComposerSubmitting(false);
        return;
      }

      const createdThread = await onCreateDraftThread({
        composerSettings,
        firstMessageText: text,
        ...(draftChatThreadSelected ? {} : { projectId: selectedProjectId ?? undefined }),
      });
      const threadId = createdThread.threadId;
      retryRestoreContext = {
        activeSelectedTurnId: null,
        draftChatThreadSelected: false,
        draftThreadProjectId: null,
        selectedProjectId: draftChatThreadSelected ? null : selectedProjectId,
        selectedThreadId: threadId,
      };
      latestComposerContextRef.current = retryRestoreContext;
      composerContextRef.current = retryRestoreContext;
      startedThreadId = threadId;
      onThreadTurnStarted(threadId);
      draftControls.clearText();
      const payload = await buildTurnPayload({
          uploads: commands?.uploads,
        threadId, text, attachments, skillInputs, skillTextElements,
        updateAttachments, rememberImagePreviewUrls,
      });
      if (commands) await commands.send(threadId, payload.input, payload.attachments, payload.images);
      else await submitThreadInput(threadId, payload.input, payload.attachments, clientUserMessageId);
      onThreadMaterialized(threadId);
      clearPendingAttachments();
      setIsComposerSubmitting(false);
    } catch (error) {
      if (optimisticClientRequestId) {
        onOptimisticUserMessageRemoved?.(optimisticClientRequestId);
      }
      if (startedThreadId) {
        onThreadTurnStartFailed(startedThreadId);
      }
      if (sameComposerContext(latestComposerContextRef.current, retryRestoreContext)) {
        draftControls.restoreDraft();
      } else {
        clearPendingAttachments();
      }
      setIsComposerSubmitting(false);
      onError(error);
    }
  }

  async function handleStopTurn() {
    if (!selectedThreadId || !(isRunning ?? Boolean(currentActiveSelectedTurnId()))) {
      return;
    }

    try {
      if (commands) await commands.stop(selectedThreadId);
      else await interruptCurrentTurn(selectedThreadId);
    } catch (error) { onError(error); }
  }

  function handleAttachmentInputChange(event: ReactChangeEvent<HTMLInputElement>) {
    if (!currentCanCompose() || isComposerSubmitting) {
      event.currentTarget.value = "";
      return;
    }
    appendFiles(event.currentTarget.files);
    event.currentTarget.value = "";
  }

  function removePendingAttachment(id: string) {
    if (isComposerSubmitting) {
      return;
    }
    setPendingAttachments((current) => {
      const removed = current.find((attachment) => attachment.id === id);
      if (removed) {
        releaseAttachmentObjectUrl(removed);
      }
      return current.filter((attachment) => attachment.id !== id);
    });
  }

  function handleComposerDragOver(event: ReactDragEvent<HTMLElement>) {
    if (!currentCanCompose() || isComposerSubmitting || !hasFiles(event.dataTransfer)) {
      return;
    }
    event.preventDefault();
    setIsComposerDragActive(true);
  }

  function handleComposerDragLeave(event: ReactDragEvent<HTMLElement>) {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setIsComposerDragActive(false);
    }
  }

  function handleComposerDrop(event: ReactDragEvent<HTMLElement>) {
    if (!currentCanCompose() || isComposerSubmitting || !hasFiles(event.dataTransfer)) {
      return;
    }
    event.preventDefault();
    setIsComposerDragActive(false);
    appendFiles(filesFromDataTransfer(event.dataTransfer));
  }

  function handleComposerPaste(event: ReactClipboardEvent<HTMLTextAreaElement>) {
    if (!currentCanCompose() || isComposerSubmitting || !hasFiles(event.clipboardData)) {
      return;
    }
    event.preventDefault();
    appendFiles(filesFromDataTransfer(event.clipboardData));
  }

  function handleComposerKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) {
      return;
    }
    const mobileInput = usesMobileComposerInput();
    if (mobileInput && !event.metaKey) {
      return;
    }

    event.preventDefault();
    const form = event.currentTarget.form;
    if (event.metaKey && !mobileInput && selectedThreadId) {
      const queueSubmitter = form?.querySelector<HTMLButtonElement>('button[data-submit-intent="queue"]');
      if (queueSubmitter && !queueSubmitter.disabled) form?.requestSubmit(queueSubmitter);
      return;
    }
    form?.requestSubmit();
  }

  function currentActiveSelectedTurnId() {
    return activeSelectedTurnIdOverrideRef?.current ?? activeSelectedTurnId;
  }

  function currentCanCompose() {
    return canComposeOverrideRef?.current ?? canCompose;
  }

  function appendFiles(fileList: FileList | File[] | null) {
    if (!fileList || isComposerSubmitting) {
      return;
    }
    const files = Array.from(fileList);
    if (files.length === 0) {
      return;
    }
    setPendingAttachments((current) => [
      ...current,
      ...files.map((file) => {
        nextAttachmentId.current += 1;
        const kind: PendingAttachment["kind"] = isImageFile(file) ? "image" : "file";
        return {
          id: `attachment-${nextAttachmentId.current}`,
          file,
          kind,
          objectUrl: kind === "image" ? createObjectUrl(file) : undefined,
          status: "pending" as const,
        };
      }),
    ]);
  }

  function clearPendingAttachments() {
    setPendingAttachments((current) => {
      for (const attachment of current) {
        releaseAttachmentObjectUrl(attachment);
      }
      return [];
    });
  }

  function updateAttachments(updates: Map<string, Partial<PendingAttachment>>) {
    if (updates.size === 0) {
      return;
    }

    const applyUpdates = (attachment: PendingAttachment) => {
      const update = updates.get(attachment.id);
      return update ? { ...attachment, ...update } : attachment;
    };
    setPendingAttachments((current) => current.map(applyUpdates));
  }

  function rememberImagePreviewUrls(previewUrls: Record<string, string>) {
    imagePreviewUrlsByPathRef.current = { ...imagePreviewUrlsByPathRef.current, ...previewUrls };
    setImagePreviewUrlsByPath(imagePreviewUrlsByPathRef.current);
    onImagePreviewUrlsChanged?.(previewUrls);
  }

  function releaseAttachmentObjectUrl(attachment: PendingAttachment) {
    if (!attachment.objectUrl || Object.values(imagePreviewUrlsByPathRef.current).includes(attachment.objectUrl)) {
      return;
    }
    revokeObjectUrl(attachment.objectUrl);
  }

  return {
    attachmentInputRef,
    handleAttachmentInputChange,
    handleComposerDragLeave,
    handleComposerDragOver,
    handleComposerDrop,
    handleComposerKeyDown,
    handleComposerPaste,
    handleStopTurn,
    handleSubmitTurn,
    imagePreviewUrlsByPath,
    isComposerDragActive,
    isComposerSubmitting,
    pendingAttachments,
    removePendingAttachment,
  };
}

function usesMobileComposerInput(): boolean {
  return isTouchInputDevice();
}

function isImageFile(file: File): boolean {
  return file.type.startsWith("image/");
}
