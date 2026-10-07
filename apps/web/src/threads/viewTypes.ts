/** Browser presentation data shared by the sidebar. It is not a backend wire contract. */
export type ThreadListEntry = {
  id: string;
  projectId?: string | null;
  createdAt?: number;
  updatedAt?: number;
  name?: string | null;
  preview?: unknown;
  status?: unknown;
  isRunning?: boolean;
  pinned?: boolean;
  unreadCompletedAgentTurn?: boolean;
};
export type ProjectListEntry = { id: string; name: string; roots: { path: string }[] };
