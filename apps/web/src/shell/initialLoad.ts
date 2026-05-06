import {
  getAccount,
  getRateLimits,
  listChatThreads,
  listPinnedThreads,
  listPendingApprovals,
  listProjects,
  type AccountResponse,
  type Approval,
  type Project,
  type RateLimitsResponse,
  type ThreadSummary,
} from "../api/client";

type LoadInitialKodexStateParams = {
  hydrateComposerDefaults: (projectId: string | null) => Promise<unknown>;
  loadProjectThreads: (projectId: string) => void;
  mergePendingApprovals: (approvals: Approval[]) => void;
  onError: (error: unknown) => void;
  onChatThreadsLoaded: (threads: ThreadSummary[]) => void;
  onPinnedThreadsLoaded: (threads: ThreadSummary[]) => void;
  onProjectsLoaded: (projects: Project[]) => void;
  setAccount: (account: AccountResponse) => void;
  setRateLimits: (rateLimits: RateLimitsResponse) => void;
};

export async function loadInitialKodexState({
  hydrateComposerDefaults,
  loadProjectThreads,
  mergePendingApprovals,
  onError,
  onChatThreadsLoaded,
  onPinnedThreadsLoaded,
  onProjectsLoaded,
  setAccount,
  setRateLimits,
}: LoadInitialKodexStateParams) {
  let composerDefaultsRequested = false;
  try {
    const projects = await listProjects();
    onProjectsLoaded(projects);
    hydrateComposerDefaults(null);
    composerDefaultsRequested = true;
    projects.forEach((project) => {
      loadProjectThreads(project.id);
    });
  } catch (error) {
    onError(error);
  }

  void listPendingApprovals().then(mergePendingApprovals).catch(onError);
  void listChatThreads().then(onChatThreadsLoaded).catch(onError);
  void listPinnedThreads().then(onPinnedThreadsLoaded).catch(onError);
  void getAccount().then(setAccount).catch(onError);
  void getRateLimits().then(setRateLimits).catch(() => undefined);

  if (!composerDefaultsRequested) {
    hydrateComposerDefaults(null);
  }
}
