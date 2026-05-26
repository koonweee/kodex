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
import { useMutation } from "@tanstack/react-query";

import {
  deleteQueuedInput,
  interruptCurrentTurn,
  retryQueuedInput,
  steerQueuedInput,
  submitThreadInput,
  uploadImages,
  type ImageUpload,
  type TextElement,
  type TimelineSkillMention,
  type UserInput,
} from "../api/client";
import type { ComposerSettings } from "../ComposerFooterControls";
import { errorMessageFrom } from "../shared/values";
import { composerTurnOptions, sameComposerContext, type ComposerContext } from "./settings";
import {
  createObjectUrl,
  hasImageFiles,
  imageFilesFromDataTransfer,
  revokeObjectUrl,
} from "./attachmentUtils";
import type { ComposerDraftControls } from "./ComposerPanel";
import { isTouchInputDevice } from "../shared/inputCapabilities";
import type { PendingAttachment, QueuedSteerRow } from "./types";

type DraftThreadCreateRequest = { firstMessageText: string; projectId?: string };
type DraftThreadCreateResult = { threadId: string; composerSettings: ComposerSettings };
type QueuedInputMutation = {
  queueId: string;
  threadId: string;
};

type UseComposerOrchestrationParams = {
  activeSelectedTurnId: string | null;
  canCompose: boolean;
  composerSettings: ComposerSettings;
  selectedThreadComposerOverride: ComposerSettings | null;
  draftChatThreadSelected: boolean;
  draftThreadProjectId: string | null;
  isDraftThreadSelected: boolean;
  onCreateDraftThread: (request: DraftThreadCreateRequest) => Promise<DraftThreadCreateResult>;
  onError: (error: unknown) => void;
  onQueuedInputDeleted: (threadId: string, queueId: string) => void;
  onQueuedInputUpsert: (row: QueuedSteerRow) => void;
  onThreadMaterialized: (threadId: string) => void;
  onThreadTurnStartFailed: (threadId: string) => void;
  onThreadTurnStarted: (threadId: string) => void;
  queuedSteerRows: QueuedSteerRow[];
  selectedProjectId: string | null;
  selectedThreadId: string | null;
};

export function useComposerOrchestration({
  activeSelectedTurnId,
  canCompose,
  composerSettings,
  selectedThreadComposerOverride,
  draftChatThreadSelected,
  draftThreadProjectId,
  isDraftThreadSelected,
  onCreateDraftThread,
  onError,
  onQueuedInputDeleted,
  onQueuedInputUpsert,
  onThreadMaterialized,
  onThreadTurnStartFailed,
  onThreadTurnStarted,
  queuedSteerRows,
  selectedProjectId,
  selectedThreadId,
}: UseComposerOrchestrationParams) {
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [isComposerSubmitting, setIsComposerSubmitting] = useState(false);
  const [isQueuedTurnStartPending, setIsQueuedTurnStartPending] = useState(false);
  const [isComposerDragActive, setIsComposerDragActive] = useState(false);
  const [imagePreviewUrlsByPath, setImagePreviewUrlsByPath] = useState<Record<string, string>>({});
  const attachmentInputRef = useRef<HTMLInputElement | null>(null);
  const composerContextRef = useRef<ComposerContext | null>(null);
  const latestComposerContextRef = useRef<ComposerContext | null>(null);
  const imagePreviewUrlsByPathRef = useRef<Record<string, string>>({});
  const previousActiveSelectedTurnIdRef = useRef<string | null>(activeSelectedTurnId);
  const nextAttachmentId = useRef(0);
  const retryQueuedInputMutation = useMutation({
    mutationFn: ({ queueId, threadId }: QueuedInputMutation) => retryQueuedInput(threadId, queueId),
    onSuccess: onQueuedInputUpsert,
  });
  const steerQueuedInputMutation = useMutation({
    mutationFn: ({ queueId, threadId }: QueuedInputMutation) => steerQueuedInput(threadId, queueId),
    onSuccess: onQueuedInputUpsert,
  });
  const deleteQueuedInputMutation = useMutation({
    mutationFn: async ({ queueId, threadId }: QueuedInputMutation) => {
      await deleteQueuedInput(threadId, queueId);
      return { queueId, threadId };
    },
    onSuccess: ({ queueId, threadId }) => onQueuedInputDeleted(threadId, queueId),
  });

  useEffect(() => {
    if (activeSelectedTurnId) {
      setIsQueuedTurnStartPending(false);
    }
    previousActiveSelectedTurnIdRef.current = activeSelectedTurnId;
  }, [activeSelectedTurnId]);

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
    if (isComposerSubmitting) {
      return;
    }

    setIsQueuedTurnStartPending(false);
    clearPendingAttachments();
  }, [activeSelectedTurnId, draftChatThreadSelected, draftThreadProjectId, isComposerSubmitting, selectedProjectId, selectedThreadId]);

  async function handleSubmitTurn(
    event: FormEvent,
    composerText: string,
    draftControls: ComposerDraftControls,
    skillInputs: UserInput[] = [],
    skillTextElements: TextElement[] = [],
    skillMentions: TimelineSkillMention[] = [],
  ) {
    event.preventDefault();
    const canSubmitComposer =
      canCompose &&
      !isComposerSubmitting &&
      !isQueuedTurnStartPending &&
      (Boolean(composerText.trim()) || pendingAttachments.length > 0);
    if (!canSubmitComposer) {
      return;
    }

    const text = composerText.trim();
    const attachments = pendingAttachments;
    let startedThreadId: string | null = null;
    let retryRestoreContext: ComposerContext = {
      activeSelectedTurnId,
      draftChatThreadSelected,
      draftThreadProjectId,
      selectedProjectId,
      selectedThreadId,
    };
    setIsComposerSubmitting(true);
    try {
      if (selectedThreadId) {
        startedThreadId = selectedThreadId;
        onThreadTurnStarted(selectedThreadId);
        draftControls.clearText();
        const input = await buildTurnInput(text, attachments, skillInputs, skillTextElements);
        const response = await submitThreadInput(
          selectedThreadId,
          input,
          selectedThreadComposerOverride ? composerTurnOptions(selectedThreadComposerOverride) : {},
        );
        if (response.queuedInput) {
          onQueuedInputUpsert(response.queuedInput);
          clearPendingAttachments();
          setIsComposerSubmitting(false);
          return;
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
      const input = await buildTurnInput(text, attachments, skillInputs, skillTextElements);
      const response = await submitThreadInput(threadId, input, composerTurnOptions(createdThread.composerSettings));
      if (response.queuedInput) {
        onQueuedInputUpsert(response.queuedInput);
        clearPendingAttachments();
        setIsComposerSubmitting(false);
        return;
      }
      onThreadMaterialized(threadId);
      clearPendingAttachments();
      setIsComposerSubmitting(false);
    } catch (error) {
      if (startedThreadId) {
        onThreadTurnStartFailed(startedThreadId);
      }
      if (sameComposerContext(latestComposerContextRef.current, retryRestoreContext)) {
        draftControls.restoreText(text);
      } else {
        clearPendingAttachments();
      }
      setIsComposerSubmitting(false);
      onError(error);
    }
  }

  async function handleStopTurn() {
    if (!selectedThreadId || !activeSelectedTurnId) {
      return;
    }

    await interruptCurrentTurn(selectedThreadId);
  }

  async function handleSubmitQueuedSteer(row: QueuedSteerRow) {
    if (isQueuedTurnStartPending || row.status === "submitting" || row.status === "steering") {
      return;
    }

    setIsQueuedTurnStartPending(true);
    try {
      if (row.status === "failed" || !activeSelectedTurnId) {
        await retryQueuedInputMutation.mutateAsync({ queueId: row.id, threadId: row.threadId });
      } else {
        await steerQueuedInputMutation.mutateAsync({ queueId: row.id, threadId: row.threadId });
      }
    } catch (error) {
      onError(error);
    } finally {
      setIsQueuedTurnStartPending(false);
    }
  }

  async function handleAbortQueuedSteer(row: QueuedSteerRow) {
    try {
      await deleteQueuedInputMutation.mutateAsync({ queueId: row.id, threadId: row.threadId });
    } catch (error) {
      onError(error);
    }
  }

  function handleAttachmentInputChange(event: ReactChangeEvent<HTMLInputElement>) {
    if (!canCompose || isComposerSubmitting) {
      event.currentTarget.value = "";
      return;
    }
    appendImageFiles(event.currentTarget.files);
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
    if (!canCompose || isComposerSubmitting || !hasImageFiles(event.dataTransfer)) {
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
    if (!canCompose || isComposerSubmitting || !hasImageFiles(event.dataTransfer)) {
      return;
    }
    event.preventDefault();
    setIsComposerDragActive(false);
    appendImageFiles(imageFilesFromDataTransfer(event.dataTransfer));
  }

  function handleComposerPaste(event: ReactClipboardEvent<HTMLTextAreaElement>) {
    if (!canCompose || isComposerSubmitting || !hasImageFiles(event.clipboardData)) {
      return;
    }
    event.preventDefault();
    appendImageFiles(imageFilesFromDataTransfer(event.clipboardData));
  }

  function handleComposerKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) {
      return;
    }
    if (usesMobileComposerInput() && !event.metaKey) {
      return;
    }

    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }

  async function buildTurnInput(
    text: string,
    attachments: PendingAttachment[],
    skillInputs: UserInput[] = [],
    skillTextElements: TextElement[] = [],
  ): Promise<UserInput[]> {
    const input: UserInput[] = [];
    if (text) {
      input.push({ type: "text", text, ...(skillTextElements.length > 0 ? { text_elements: skillTextElements } : {}) });
    }
    input.push(...skillInputs);
    if (attachments.length > 0) {
      const attachmentsToUpload = attachments.filter((attachment) => !attachment.uploaded);
      updateAttachments(
        new Map(
          attachmentsToUpload.map((attachment) => [
            attachment.id,
            { status: "uploading" as const, error: undefined },
          ]),
        ),
      );
      let uploads: ImageUpload[] = [];
      try {
        uploads =
          attachmentsToUpload.length > 0
            ? await uploadImages(attachmentsToUpload.map((attachment) => attachment.file))
            : [];
        if (uploads.length !== attachmentsToUpload.length) {
          throw new Error("Gateway upload response did not match selected attachments");
        }
      } catch (error) {
        const message = errorMessageFrom(error);
        updateAttachments(
          new Map(
            attachmentsToUpload.map((attachment) => [
              attachment.id,
              { status: "error" as const, error: message },
            ]),
          ),
        );
        throw error;
      }

      const previewUrls: Record<string, string> = {};
      const uploadedByAttachmentId = new Map<string, ImageUpload>();
      for (const [index, upload] of uploads.entries()) {
        const attachment = attachmentsToUpload[index];
        if (attachment) {
          uploadedByAttachmentId.set(attachment.id, upload);
          previewUrls[upload.path] = attachment.objectUrl;
        }
      }
      updateAttachments(
        new Map(
          attachmentsToUpload.map((attachment) => [
            attachment.id,
            { status: "uploaded" as const, uploaded: uploadedByAttachmentId.get(attachment.id), error: undefined },
          ]),
        ),
      );
      for (const attachment of attachments) {
        const upload = attachment.uploaded ?? uploadedByAttachmentId.get(attachment.id);
        if (!upload) {
          continue;
        }
        input.push({ type: "localImage", path: upload.path });
      }
      if (Object.keys(previewUrls).length > 0) {
        rememberImagePreviewUrls(previewUrls);
      }
    }
    return input;
  }

  function appendImageFiles(fileList: FileList | File[] | null) {
    if (!fileList || isComposerSubmitting) {
      return;
    }
    const files = Array.from(fileList).filter((file) => file.type.startsWith("image/"));
    if (files.length === 0) {
      return;
    }
    setPendingAttachments((current) => [
      ...current,
      ...files.map((file) => {
        nextAttachmentId.current += 1;
        return {
          id: `attachment-${nextAttachmentId.current}`,
          file,
          objectUrl: createObjectUrl(file),
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
  }

  function releaseAttachmentObjectUrl(attachment: PendingAttachment) {
    if (Object.values(imagePreviewUrlsByPathRef.current).includes(attachment.objectUrl)) {
      return;
    }
    revokeObjectUrl(attachment.objectUrl);
  }

  return {
    attachmentInputRef,
    handleAbortQueuedSteer,
    handleAttachmentInputChange,
    handleComposerDragLeave,
    handleComposerDragOver,
    handleComposerDrop,
    handleComposerKeyDown,
    handleComposerPaste,
    handleStopTurn,
    handleSubmitQueuedSteer,
    handleSubmitTurn,
    imagePreviewUrlsByPath,
    isComposerDragActive,
    isComposerSubmitting,
    isQueuedTurnStartPending,
    pendingAttachments,
    queuedSteerRows,
    removePendingAttachment,
  };
}

function usesMobileComposerInput(): boolean {
  return isTouchInputDevice();
}
