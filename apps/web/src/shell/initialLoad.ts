import { getAccount, listPendingApprovals, listProjects, type AccountResponse, type Approval, type Project } from "../api/client";

type LoadInitialKodexStateParams = {
  hydrateComposerDefaults: (projectId: string | null) => void;
  loadProjectThreads: (projectId: string, options?: { selectWhenLoaded?: boolean }) => void;
  mergePendingApprovals: (approvals: Approval[]) => void;
  onError: (error: unknown) => void;
  onProjectsLoaded: (projects: Project[], firstProjectId: string | null) => void;
  setAccount: (account: AccountResponse) => void;
};

export async function loadInitialKodexState({
  hydrateComposerDefaults,
  loadProjectThreads,
  mergePendingApprovals,
  onError,
  onProjectsLoaded,
  setAccount,
}: LoadInitialKodexStateParams) {
  let composerDefaultsRequested = false;
  try {
    const projects = await listProjects();
    const firstProjectId = projects[0]?.id ?? null;
    onProjectsLoaded(projects, firstProjectId);
    hydrateComposerDefaults(firstProjectId);
    composerDefaultsRequested = true;
    projects.forEach((project, index) => {
      loadProjectThreads(project.id, { selectWhenLoaded: index === 0 });
    });
  } catch (error) {
    onError(error);
  }

  void listPendingApprovals().then(mergePendingApprovals).catch(onError);
  void getAccount().then(setAccount).catch(onError);

  if (!composerDefaultsRequested) {
    hydrateComposerDefaults(null);
  }
}
