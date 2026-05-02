import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent as ReactChangeEvent,
  type ClipboardEvent as ReactClipboardEvent,
  type Dispatch,
  type DragEvent as ReactDragEvent,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type SetStateAction,
} from "react";

import { interruptTurn, startTurn, steerTurn, uploadImages, type ImageUpload, type UserInput } from "../api/client";
import type { ComposerSettings } from "../ComposerFooterControls";
import { errorMessageFrom } from "../shared/values";
import {
  addOptimisticUserMessage,
  removeOptimisticUserMessage,
  updateOptimisticUserMessage,
  type TimelineImage,
  type TimelineState,
} from "../timeline/reducer";
import { composerTurnOptions, sameComposerContext, type ComposerContext } from "./settings";
import {
  attachmentPreviewImages,
  createObjectUrl,
  hasImageFiles,
  imageFilesFromDataTransfer,
  revokeObjectUrl,
  userInputImages,
} from "./attachmentUtils";
import type { PendingAttachment, QueuedSteerRow } from "./types";

type DraftThreadCreateRequest = { firstMessageText: string; projectId: string };

type UseComposerOrchestrationParams = {
  activeSelectedTurnId: string | null;
  canCompose: boolean;
  composerSettings: ComposerSettings;
  draftThreadProjectId: string | null;
  isDraftThreadSelected: boolean;
  onCreateDraftThread: (request: DraftThreadCreateRequest) => Promise<string>;
  onError: (error: unknown) => void;
  selectedProjectId: string | null;
  selectedThreadId: string | null;
  setTimeline: Dispatch<SetStateAction<TimelineState>>;
};

export function useComposerOrchestration({
  activeSelectedTurnId,
  canCompose,
  composerSettings,
  draftThreadProjectId,
  isDraftThreadSelected,
  onCreateDraftThread,
  onError,
  selectedProjectId,
  selectedThreadId,
  setTimeline,
}: UseComposerOrchestrationParams) {
  const [composerText, setComposerText] = useState("");
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [isComposerSubmitting, setIsComposerSubmitting] = useState(false);
  const [isComposerDragActive, setIsComposerDragActive] = useState(false);
  const [imagePreviewUrlsByPath, setImagePreviewUrlsByPath] = useState<Record<string, string>>({});
  const [queuedSteerRows, setQueuedSteerRows] = useState<QueuedSteerRow[]>([]);
  const attachmentInputRef = useRef<HTMLInputElement | null>(null);
  const composerContextRef = useRef<ComposerContext | null>(null);
  const latestComposerContextRef = useRef<ComposerContext | null>(null);
  const imagePreviewUrlsByPathRef = useRef<Record<string, string>>({});
  const nextAttachmentId = useRef(0);
  const nextOptimisticMessageId = useRef(0);
  const nextQueuedSteerId = useRef(0);

  const canSubmitComposer =
    canCompose && !isComposerSubmitting && (Boolean(composerText.trim()) || pendingAttachments.length > 0);
  const shouldShowStopAction = activeSelectedTurnId !== null && !canSubmitComposer;

  useEffect(() => {
    const nextContext = { activeSelectedTurnId, draftThreadProjectId, selectedProjectId, selectedThreadId };
    const previousContext = composerContextRef.current;
    composerContextRef.current = nextContext;
    latestComposerContextRef.current = nextContext;
    if (
      previousContext &&
      previousContext.activeSelectedTurnId === activeSelectedTurnId &&
      previousContext.draftThreadProjectId === draftThreadProjectId &&
      previousContext.selectedProjectId === selectedProjectId &&
      previousContext.selectedThreadId === selectedThreadId
    ) {
      return;
    }
    if (isComposerSubmitting) {
      return;
    }

    setQueuedSteerRows((current) => {
      for (const row of current) {
        for (const attachment of row.attachments) {
          releaseAttachmentObjectUrl(attachment);
        }
      }
      return [];
    });
    clearPendingAttachments();
  }, [activeSelectedTurnId, draftThreadProjectId, isComposerSubmitting, selectedProjectId, selectedThreadId]);

  async function handleSubmitTurn(event: FormEvent) {
    event.preventDefault();
    if (!canSubmitComposer) {
      return;
    }

    const text = composerText.trim();
    const attachments = pendingAttachments;
    if (selectedThreadId && activeSelectedTurnId) {
      const id = `queued-steer-${nextQueuedSteerId.current + 1}`;
      nextQueuedSteerId.current += 1;
      setQueuedSteerRows((current) => [...current, { id, text, attachments }]);
      setComposerText("");
      setPendingAttachments([]);
      return;
    }

    const optimisticImages = attachmentPreviewImages(attachments);
    const initialConfirmationState = attachments.length > 0 ? "uploading" : "sending";
    let optimisticClientRequestId: string | null = null;
    let retryRestoreContext: ComposerContext = {
      activeSelectedTurnId,
      draftThreadProjectId,
      selectedProjectId,
      selectedThreadId,
    };
    setIsComposerSubmitting(true);
    try {
      if (selectedThreadId) {
        optimisticClientRequestId = addOptimisticMessage(text, optimisticImages, null, initialConfirmationState);
        setComposerText("");
        const input = await buildTurnInput(text, attachments);
        const uploadedImages = userInputImages(input);
        if (uploadedImages.length > 0) {
          updateOptimisticMessage(optimisticClientRequestId, {
            images: uploadedImages,
            confirmationState: "sending",
            error: undefined,
          });
        }
        await startTurn(selectedThreadId, input, composerTurnOptions(composerSettings));
        updateOptimisticMessage(optimisticClientRequestId, { confirmationState: "sent", error: undefined });
        clearPendingAttachments();
        setIsComposerSubmitting(false);
        return;
      }

      if (!isDraftThreadSelected || !selectedProjectId) {
        setIsComposerSubmitting(false);
        return;
      }

      const threadId = await onCreateDraftThread({ firstMessageText: text, projectId: selectedProjectId });
      retryRestoreContext = {
        activeSelectedTurnId: null,
        draftThreadProjectId: null,
        selectedProjectId,
        selectedThreadId: threadId,
      };
      latestComposerContextRef.current = retryRestoreContext;
      composerContextRef.current = retryRestoreContext;
      optimisticClientRequestId = addOptimisticMessage(text, optimisticImages, null, initialConfirmationState);
      setComposerText("");
      const input = await buildTurnInput(text, attachments);
      const uploadedImages = userInputImages(input);
      if (uploadedImages.length > 0) {
        updateOptimisticMessage(optimisticClientRequestId, {
          images: uploadedImages,
          confirmationState: "sending",
          error: undefined,
        });
      }
      await startTurn(threadId, input, composerTurnOptions(composerSettings));
      updateOptimisticMessage(optimisticClientRequestId, { confirmationState: "sent", error: undefined });
      clearPendingAttachments();
      setIsComposerSubmitting(false);
    } catch (error) {
      if (optimisticClientRequestId) {
        const clientRequestId = optimisticClientRequestId;
        setTimeline((current) => removeOptimisticUserMessage(current, clientRequestId));
      }
      if (sameComposerContext(latestComposerContextRef.current, retryRestoreContext)) {
        setComposerText(text);
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

    await interruptTurn(selectedThreadId, activeSelectedTurnId);
  }

  async function handleSubmitQueuedSteer(row: QueuedSteerRow) {
    if (!selectedThreadId || !activeSelectedTurnId) {
      return;
    }

    const optimisticClientRequestId = addOptimisticMessage(
      row.text,
      attachmentPreviewImages(row.attachments),
      activeSelectedTurnId,
      row.attachments.length > 0 ? "uploading" : "sending",
    );
    setQueuedSteerRows((current) =>
      current.map((item) => (item.id === row.id ? { ...item, isSubmitting: true } : item)),
    );
    try {
      const input = await buildTurnInput(row.text, row.attachments);
      const uploadedImages = userInputImages(input);
      if (uploadedImages.length > 0) {
        updateOptimisticMessage(optimisticClientRequestId, {
          images: uploadedImages,
          confirmationState: "sending",
          error: undefined,
        });
      }
      await steerTurn(selectedThreadId, activeSelectedTurnId, input);
      updateOptimisticMessage(optimisticClientRequestId, { confirmationState: "sent", error: undefined });
      for (const attachment of row.attachments) {
        releaseAttachmentObjectUrl(attachment);
      }
      setQueuedSteerRows((current) => current.filter((item) => item.id !== row.id));
    } catch (error) {
      setTimeline((current) => removeOptimisticUserMessage(current, optimisticClientRequestId));
      setQueuedSteerRows((current) =>
        current.map((item) => (item.id === row.id ? { ...item, isSubmitting: false } : item)),
      );
      onError(error);
    }
  }

  function handleAbortQueuedSteer(row: QueuedSteerRow) {
    for (const attachment of row.attachments) {
      releaseAttachmentObjectUrl(attachment);
    }
    setQueuedSteerRows((current) => current.filter((item) => item.id !== row.id));
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

    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }

  function clearComposerText() {
    setComposerText("");
  }

  async function buildTurnInput(text: string, attachments: PendingAttachment[]): Promise<UserInput[]> {
    const input: UserInput[] = [];
    if (text) {
      input.push({ type: "text", text });
    }
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
    setQueuedSteerRows((current) =>
      current.map((row) => ({
        ...row,
        attachments: row.attachments.map(applyUpdates),
      })),
    );
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

  function addOptimisticMessage(
    text: string,
    images: TimelineImage[],
    turnId: string | null,
    confirmationState: "uploading" | "sending" | "sent" | "failed",
  ) {
    nextOptimisticMessageId.current += 1;
    const clientRequestId = `client-message-${nextOptimisticMessageId.current}`;
    setTimeline((current) =>
      addOptimisticUserMessage(current, {
        clientRequestId,
        text,
        images,
        turnId,
        confirmationState,
      }),
    );
    return clientRequestId;
  }

  function updateOptimisticMessage(clientRequestId: string, update: Parameters<typeof updateOptimisticUserMessage>[2]) {
    setTimeline((current) => updateOptimisticUserMessage(current, clientRequestId, update));
  }

  return {
    attachmentInputRef,
    canSubmitComposer,
    clearComposerText,
    composerText,
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
    pendingAttachments,
    queuedSteerRows,
    removePendingAttachment,
    setComposerText,
    shouldShowStopAction,
  };
}
