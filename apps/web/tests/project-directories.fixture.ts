import type { BrowserContext } from "@playwright/test";

import type { DirectoryListResponse } from "../src/api/client";

export const pickerHome = "/home/kodex";
export const pickerRoot = `${pickerHome}/repos/Research`;

export async function projectDirectoriesFixture(context: BrowserContext, failRootOnce = false) {
  const requestedPaths: Array<string | null> = [];
  const listings: Record<string, DirectoryListResponse> = {
    [pickerHome]: {
      path: pickerHome, homePath: pickerHome, parentPath: null,
      directories: [{ name: "repos", path: `${pickerHome}/repos` }],
    },
    [`${pickerHome}/repos`]: {
      path: `${pickerHome}/repos`, homePath: pickerHome, parentPath: pickerHome,
      directories: [{ name: "Research", path: pickerRoot }],
    },
    [pickerRoot]: {
      path: pickerRoot, homePath: pickerHome, parentPath: `${pickerHome}/repos`,
      directories: [{ name: "drafts", path: `${pickerRoot}/drafts` }],
    },
    [`${pickerRoot}/drafts`]: {
      path: `${pickerRoot}/drafts`, homePath: pickerHome, parentPath: pickerRoot,
      directories: [],
    },
  };
  await context.route("**/v1/directories**", async (route) => {
    const path = new URL(route.request().url()).searchParams.get("path");
    requestedPaths.push(path);
    if (path === pickerRoot && failRootOnce) {
      failRootOnce = false;
      await route.fulfill({ status: 404, json: { code: "not_found", message: "Directory unavailable", retryable: false } });
      return;
    }
    const listing = listings[path ?? pickerHome];
    if (!listing) throw new Error(`Unexpected directory read: ${path}`);
    await route.fulfill({ json: listing });
  });
  return { requestedPaths };
}
