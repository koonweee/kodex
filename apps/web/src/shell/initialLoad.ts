import {
  getAccount,
  getRateLimits,
  listPendingApprovals,
  listProjects,
  type AccountResponse,
  type Approval,
  type Project,
  type RateLimitsResponse,
} from "../api/client";

type LoadInitialKodexStateParams = {
  hydrateComposerDefaults: (projectId: string | null) => void;
  loadProjectThreads: (projectId: string, options?: { selectWhenLoaded?: boolean }) => void;
  mergePendingApprovals: (approvals: Approval[]) => void;
  onError: (error: unknown) => void;
  onProjectsLoaded: (projects: Project[]) => string | null;
  setAccount: (account: AccountResponse) => void;
  setRateLimits: (rateLimits: RateLimitsResponse) => void;
};

export async function loadInitialKodexState({
  hydrateComposerDefaults,
  loadProjectThreads,
  mergePendingApprovals,
  onError,
  onProjectsLoaded,
  setAccount,
  setRateLimits,
}: LoadInitialKodexStateParams) {
  let composerDefaultsRequested = false;
  try {
    const projects = await listProjects();
    const firstProjectId = onProjectsLoaded(projects);
    hydrateComposerDefaults(firstProjectId);
    composerDefaultsRequested = true;
    projects.forEach((project) => {
      loadProjectThreads(project.id, { selectWhenLoaded: project.id === firstProjectId });
    });
  } catch (error) {
    onError(error);
  }

  void listPendingApprovals().then(mergePendingApprovals).catch(onError);
  void getAccount().then(setAccount).catch(onError);
  void getRateLimits().then(setRateLimits).catch(() => undefined);

  if (!composerDefaultsRequested) {
    hydrateComposerDefaults(null);
  }
}
