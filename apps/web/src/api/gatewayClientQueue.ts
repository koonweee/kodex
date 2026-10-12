import type { components } from "./generated/schema";
import type {
  PromotionOutcome,
  QueuedInput,
  QueuedInputListResponse,
  ThreadCompactResponse,
  TimelineFileAttachment,
  UserInput,
} from "./client";
import { unwrap, type GatewayClientDependencies } from "./gatewayClientShared";

export function createGatewayQueue({
  api,
}: GatewayClientDependencies) {
  async function submitThreadInput(
    threadId: string,
    input: UserInput[],
    attachments: TimelineFileAttachment[] = [],
    clientUserMessageId?: components["schemas"]["TurnStartRequest"]["clientUserMessageId"],
    queuePolicy?: "ifPending" | "ifEmpty",
  ): Promise<components["schemas"]["ThreadInputResponse"]> {
    return unwrap(
      api.POST("/v1/threads/{threadId}/input", {
        params: { path: { threadId } },
        body: { input, ...(queuePolicy === "ifPending" ? { queueIfPending: true } : queuePolicy === "ifEmpty" ? { queueIfEmpty: true } : {}), ...(attachments.length > 0 ? { attachments } : {}), ...(clientUserMessageId !== undefined ? { clientUserMessageId } : {}) },
      }),
    );
  }
  async function compactThread(threadId: string): Promise<ThreadCompactResponse> {
    return unwrap(
      api.POST("/v1/threads/{threadId}/compact", {
        params: { path: { threadId } },
      }),
    );
  }
  async function listQueuedInputs(threadId: string, signal?: AbortSignal): Promise<QueuedInputListResponse> {
    return unwrap(api.GET("/v1/threads/{threadId}/queued-inputs", {
      params: { path: { threadId } }, cache: "no-store", signal,
    }));
  }
  async function createQueuedInput(
    threadId: string,
    input: QueuedInput["input"],
    attachments: TimelineFileAttachment[] = [],
    clientUserMessageId?: string,
  ): Promise<QueuedInput> {
    const response = await unwrap(api.POST("/v1/threads/{threadId}/queued-inputs", {
      params: { path: { threadId } },
      body: { input, ...(attachments.length > 0 ? { attachments } : {}), ...(clientUserMessageId !== undefined ? { clientUserMessageId } : {}) },
    }));
    return response.queuedInput;
  }
  async function updateQueuedInput(threadId: string, queueId: string, input: QueuedInput["input"]) {
    return unwrap(api.PUT("/v1/threads/{threadId}/queued-inputs/{queueId}", {
      params: { path: { threadId, queueId } }, body: { input },
    }));
  }
  async function reorderQueuedInputs(threadId: string, queuedSubmissionIds: string[]) {
    return unwrap(api.POST("/v1/threads/{threadId}/queued-inputs/reorder", {
      params: { path: { threadId } }, body: { queuedSubmissionIds },
    }));
  }
  async function sendFirstQueuedInputNow(threadId: string): Promise<PromotionOutcome> {
    return unwrap(api.POST("/v1/threads/{threadId}/queued-inputs/steer-first", {
      params: { path: { threadId } },
    }));
  }
  async function sendQueuedInputNow(threadId: string, queueId: string): Promise<PromotionOutcome> {
    return unwrap(api.POST("/v1/threads/{threadId}/queued-inputs/{queueId}/steer", {
      params: { path: { threadId, queueId } },
    }));
  }
  async function deleteQueuedInput(threadId: string, queueId: string) {
    return unwrap(api.DELETE("/v1/threads/{threadId}/queued-inputs/{queueId}", {
      params: { path: { threadId, queueId } },
    }));
  }
  async function reconcileQueueTransfer(transferId: string): Promise<PromotionOutcome> {
    return unwrap(api.POST("/v1/queue-transfers/{transferId}/reconcile", { params: { path: { transferId } } }));
  }
  async function dismissQueueTransfer(transferId: string) {
    return unwrap(api.DELETE("/v1/queue-transfers/{transferId}", { params: { path: { transferId } } }));
  }

  return {
    submitThreadInput,
    compactThread,
    listQueuedInputs,
    createQueuedInput,
    updateQueuedInput,
    reorderQueuedInputs,
    sendFirstQueuedInputNow,
    sendQueuedInputNow,
    deleteQueuedInput,
    reconcileQueueTransfer,
    dismissQueueTransfer,
  };
}
