import type { components, paths } from "./generated/schema";
import type { components as federationComponents } from "./generated/federation";

export type FederatedExecutor = federationComponents["schemas"]["ExecutorRecord"];
export type FederatedExecutorListResponse = federationComponents["schemas"]["ExecutorListResponse"];
export type RegisterFederatedExecutorRequest = federationComponents["schemas"]["RegisterExecutorRequest"];
export type UpdateFederatedExecutorRequest = federationComponents["schemas"]["UpdateExecutorRequest"];

export type ThreadDeliveryOptions = Pick<NonNullable<paths["/v1/threads/{threadId}"]["get"]["parameters"]["query"]>, "includeDebugEvents" | "includeCommandOutputs">;

export type AccountLoginCompleted = components["schemas"]["AccountLoginCompleted"];
export type LoginStartResponse = components["schemas"]["LoginStartResponse"];
export type AccountResponse = components["schemas"]["AccountResponse"];
export type Approval = components["schemas"]["Approval"];
export type ApprovalListResponse = components["schemas"]["ApprovalListResponse"];
export type ApprovalResponse = Record<string, unknown>;
export type AutomationRun = components["schemas"]["AutomationRun"];
export type Automation = components["schemas"]["AutomationDto"];
export type AutomationCreateRequest = components["schemas"]["AutomationCreateRequest"];
export type AutomationUpdateRequest = components["schemas"]["AutomationUpdateRequest"];
export type Capabilities = components["schemas"]["CapabilitiesResponse"];
export type ComposerSettingsResponse = components["schemas"]["ComposerSettingsResponse"];
export type ComposerSettingsUpdateRequest = components["schemas"]["ComposerSettingsUpdateRequest"];
export type ComposerSettingsUpdateResponse = components["schemas"]["ComposerSettingsUpdateResponse"];
export type NativeConfigWriteTarget = components["schemas"]["NativeConfigWriteTarget"];
export type NativeConfigWriteResult = components["schemas"]["NativeConfigWriteResult"];
export type EventEnvelope = components["schemas"]["EventEnvelope"];
export type AppSurfaceBridgeRequest = components["schemas"]["AppSurfaceBridgeRequest"];
export type AppSurfaceBridgeResponse = components["schemas"]["AppSurfaceBridgeResponse"];
export type AppSurfaceSession = components["schemas"]["AppSurfaceSessionDto"];
export type ConfiguredMcpServer = components["schemas"]["ConfiguredMcpServer"];
export type ConfiguredMcpServerListResponse = components["schemas"]["ConfiguredMcpServerListResponse"];
export type McpConfigMutationResponse = components["schemas"]["McpConfigMutationResponse"];
export type McpOAuthLoginResponse = components["schemas"]["McpOAuthLoginResponse"];
export type McpResource = components["schemas"]["McpResource"];
export type McpResourceReadResponse = components["schemas"]["McpResourceReadResponse"];
export type McpServerInstallRequest = components["schemas"]["McpServerInstallRequest"];
export type McpServerUpdateRequest = components["schemas"]["McpServerUpdateRequest"];
export type McpReloadResponse = components["schemas"]["McpReloadResponse"];
export type McpServerListResponse = components["schemas"]["McpServerListResponse"];
export type McpServerStatus = components["schemas"]["McpServerStatus"];
export type ModelSummary = components["schemas"]["ModelSummary"];
export type PendingTimelineRequestSummary = components["schemas"]["PendingTimelineRequestSummary"];
export type PermissionProfileSummary = components["schemas"]["PermissionProfileSummary"];
export type DirectoryListResponse = components["schemas"]["DirectoryListResponse"];
export type Project = components["schemas"]["Project"];
export type CreateProjectRequest = components["schemas"]["CreateProjectRequest"];
export type UpdateProjectRequest = components["schemas"]["UpdateProjectRequest"];
export type QueuedInput = components["schemas"]["QueuedInput"];
export type QueuedInputListResponse = components["schemas"]["QueuedInputListResponse"];
export type QueueTransfer = components["schemas"]["QueueTransfer"];
export type PromotionOutcome = components["schemas"]["PromotionOutcome"];
export type RateLimitSnapshot = components["schemas"]["RateLimitSnapshot"];
export type RateLimitWindow = components["schemas"]["RateLimitWindow"];
export type RateLimitsResponse = components["schemas"]["RateLimitsResponse"];
export type SkillMetadata = components["schemas"]["SkillMetadata"];
export type SkillsCatalogResponse = components["schemas"]["SkillsCatalogResponse"];
export type UnreadBadgeResponse = components["schemas"]["UnreadBadgeResponse"];
export type ThreadRead = components["schemas"]["ThreadRead"];
export type MarkThreadSeenRequest = components["schemas"]["MarkThreadSeenRequest"];
export type ThreadSettingsUpdateRequest = components["schemas"]["ThreadSettingsUpdateRequest"];
export type ThreadSettingsResponse = components["schemas"]["ThreadSettingsResponse"];
export type ThreadGoal = components["schemas"]["ThreadGoal"];
export type ThreadGoalUpdateRequest = components["schemas"]["ThreadGoalSetRequest"];
export type ThreadNotificationSettingsResponse = components["schemas"]["ThreadNotificationSettingsResponse"];
export type ThreadViewPresenceSnapshotRequest = components["schemas"]["ThreadViewPresenceSnapshotRequest"];
export type ThreadListResponse = components["schemas"]["ThreadListResponse"];
export type SidebarThreadSummary = components["schemas"]["SidebarThreadSummary"];
export type SidebarThreadsResponse = components["schemas"]["SidebarThreadsResponse"];
export type ThreadViewResponse = components["schemas"]["ThreadViewResponse"];
export type ThreadViewThreadSummary = components["schemas"]["ThreadViewThreadSummary"];
export type ThreadSubagentSummary = components["schemas"]["ThreadSubagentSummary"];
export type ThreadSubagentListResponse = components["schemas"]["ThreadSubagentListResponse"];
export type TextElement = components["schemas"]["TextElement"];
export type ThreadSummary = components["schemas"]["ThreadSummary"];
export type ThreadTimelineFileChangeEntry = components["schemas"]["ThreadTimelineFileChangeEntry"];
export type ThreadTimelineRow = components["schemas"]["ThreadTimelineRow"];
export type ThreadTimelineSnapshot = components["schemas"]["ThreadTimelineSnapshot"];
export type ThreadTimelineSnapshotItem = components["schemas"]["ThreadTimelineSnapshotItem"];
export type ThreadTimelineWorkDetailRow = components["schemas"]["ThreadTimelineWorkDetailRow"];
export type ThreadTimelineWindowPage = components["schemas"]["ThreadTimelineWindowPage"];
export type ThreadInterruptCurrentResponse = components["schemas"]["ThreadInterruptCurrentResponse"];
export type ThreadCompactResponse = components["schemas"]["ThreadCompactResponse"];
export type TimelineSkillMention = components["schemas"]["TimelineSkillMention"];
export type ThreadViewPatch = components["schemas"]["ThreadViewPatch"];
export type UserInput = components["schemas"]["UserInput"];
export type ImageUpload = components["schemas"]["ImageUpload"];
export type TimelineFileAttachment = components["schemas"]["TimelineFileAttachment"];
export type CreateThreadOptions = Omit<components["schemas"]["CreateThreadRequest"], "payload" | "projectId">;
export type NotificationStatusResponse = components["schemas"]["NotificationStatusResponse"];
export type PushSubscriptionUpsertResponse = components["schemas"]["PushSubscriptionUpsertResponse"];
export type CurrentPushSubscriptionStatusResponse = components["schemas"]["CurrentPushSubscriptionResponse"];
export type TestNotificationResponse = components["schemas"]["TestNotificationResponse"];
export type CreateTerminalSession = components["schemas"]["CreateTerminalSession"];
export type TerminalDeleteResponse = components["schemas"]["TerminalDeleteResponse"];
export type TerminalSessionInfo = components["schemas"]["TerminalSessionInfo"];

export { GatewayRequestError } from "./gatewayClientShared";
export {
  createExecutorGatewayClient,
  createGatewayClient,
  type ExecutorGatewayClientOptions,
  type GatewayClientOptions,
} from "./gatewayClient";

import { createGatewayClient } from "./gatewayClient";

const defaultGatewayClient = createGatewayClient();

export const {
  terminalWebSocketUrl,
  filePreviewUrl,
  skillIconUrl,
  fetchThreadFilePreview,
  getCapabilities,
  listTerminalSessions,
  createTerminalSession,
  deleteTerminalSession,
  listDirectories,
  listProjects,
  getProject,
  createProject,
  updateProject,
  deleteProject,
  moveProject,
  listThreadsPage,
  getSidebarThreads,
  listChatThreadsPage,
  createThread,
  createChatThread,
  attachThread,
  getThreadDetail,
  getThreadTimelinePage,
  listThreadSubagents,
  getThreadAppSurface,
  callAppSurfaceBridge,
  archiveThread,
  renameThread,
  setThreadNotificationsEnabled,
  getThreadSettings,
  getThreadGoal,
  updateThreadGoal,
  clearThreadGoal,
  updateThreadSettings,
  setThreadPinned,
  listPinnedThreads,
  getUnreadBadge,
  markThreadSeen,
  replaceThreadViewPresence,
  sendThreadViewPresenceSnapshotBeacon,
  getNotificationStatus,
  getCurrentPushSubscriptionStatus,
  upsertPushSubscription,
  deleteCurrentPushSubscription,
  sendTestNotification,
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
  listAutomations,
  listAutomationRuns,
  createAutomation,
  updateAutomation,
  pauseAutomation,
  resumeAutomation,
  deleteAutomation,
  interruptCurrentTurn,
  uploadImages,
  uploadFiles,
  listPendingApprovals,
  decideApproval,
  getAccount,
  startLogin,
  cancelLogin,
  logout,
  getRateLimits,
  consumeRateLimitResetCredit,
  listModels,
  listMcpServers,
  listConfiguredMcpServers,
  addMcpServer,
  updateMcpServer,
  setMcpServerEnabled,
  removeMcpServer,
  reloadMcpServers,
  startMcpOAuthLogin,
  readMcpResource,
  listSkills,
  listPermissionProfiles,
  getComposerSettings,
  persistComposerSettings,
} = defaultGatewayClient;
