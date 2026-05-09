import { QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

import { listSkills, type SkillMetadata } from "../api/client";
import { createKodexQueryClient } from "../api/queryClient";
import { useSkillCatalog } from "./useSkillCatalog";

vi.mock("../api/client", async (importActual) => ({
  ...(await importActual<typeof import("../api/client")>()),
  listSkills: vi.fn(),
}));

function skillFixture(name: string): SkillMetadata {
  return {
    description: `${name} description`,
    enabled: true,
    interface: null,
    name,
    path: `/skills/${name}/SKILL.md`,
    scope: "user",
  };
}

function skillsResponse(cwd: string | null, skills: SkillMetadata[], errors: Array<{ message: string; path: string }> = []) {
  return {
    cwd,
    errors,
    invalidationGeneration: 0,
    skills,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

function queryWrapper() {
  const queryClient = createKodexQueryClient();
  return function TestQueryProvider({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe("useSkillCatalog", () => {
  it("loads skills for the current cwd", async () => {
    vi.mocked(listSkills).mockResolvedValue(skillsResponse("/workspace", [skillFixture("review-fix")]));

    const { result } = renderHook(
      () => useSkillCatalog({ cwd: "/workspace", enabled: true, invalidationGeneration: 0 }),
      { wrapper: queryWrapper() },
    );

    await waitFor(() => expect(result.current.skills.map((skill) => skill.name)).toEqual(["review-fix"]));
    expect(vi.mocked(listSkills)).toHaveBeenCalledWith("/workspace", false);
    expect(result.current.error).toBeNull();
  });

  it("keeps previous skills visible while a cwd change is loading", async () => {
    const nextSkills = deferred<ReturnType<typeof skillsResponse>>();
    vi.mocked(listSkills).mockImplementation((cwd) =>
      cwd === "/next"
        ? nextSkills.promise
        : Promise.resolve(skillsResponse("/workspace", [skillFixture("imagegen")])),
    );

    const { result, rerender } = renderHook(
      ({ cwd }) => useSkillCatalog({ cwd, enabled: true, invalidationGeneration: 0 }),
      { initialProps: { cwd: "/workspace" }, wrapper: queryWrapper() },
    );

    await waitFor(() => expect(result.current.skills.map((skill) => skill.name)).toEqual(["imagegen"]));

    rerender({ cwd: "/next" });

    expect(result.current.loading).toBe(true);
    expect(result.current.skills.map((skill) => skill.name)).toEqual(["imagegen"]);

    nextSkills.resolve(skillsResponse("/next", [skillFixture("github:github")]));

    await waitFor(() => expect(result.current.skills.map((skill) => skill.name)).toEqual(["github:github"]));
  });

  it("force-refreshes when skills.changed invalidates the catalog", async () => {
    vi.mocked(listSkills)
      .mockResolvedValueOnce(skillsResponse("/workspace", [skillFixture("review-fix")]))
      .mockResolvedValueOnce(skillsResponse("/workspace", [skillFixture("review-fix"), skillFixture("imagegen")]));

    const { result, rerender } = renderHook(
      ({ invalidationGeneration }) =>
        useSkillCatalog({ cwd: "/workspace", enabled: true, invalidationGeneration }),
      { initialProps: { invalidationGeneration: 0 }, wrapper: queryWrapper() },
    );

    await waitFor(() => expect(result.current.skills.map((skill) => skill.name)).toEqual(["review-fix"]));

    rerender({ invalidationGeneration: 1 });

    await waitFor(() =>
      expect(result.current.skills.map((skill) => skill.name)).toEqual(["review-fix", "imagegen"]),
    );
    expect(vi.mocked(listSkills)).toHaveBeenLastCalledWith("/workspace", true);
  });

  it("preserves previous skills when a refresh fails", async () => {
    vi.mocked(listSkills)
      .mockResolvedValueOnce(skillsResponse("/workspace", [skillFixture("review-fix")]))
      .mockRejectedValueOnce(new Error("catalog unavailable"));

    const { result, rerender } = renderHook(
      ({ invalidationGeneration }) =>
        useSkillCatalog({ cwd: "/workspace", enabled: true, invalidationGeneration }),
      { initialProps: { invalidationGeneration: 0 }, wrapper: queryWrapper() },
    );

    await waitFor(() => expect(result.current.skills.map((skill) => skill.name)).toEqual(["review-fix"]));

    rerender({ invalidationGeneration: 1 });

    await waitFor(() => expect(result.current.error).toEqual("catalog unavailable"));
    expect(result.current.skills.map((skill) => skill.name)).toEqual(["review-fix"]);
  });

  it("surfaces response errors without dropping loaded skills", async () => {
    vi.mocked(listSkills).mockResolvedValue(
      skillsResponse("/workspace", [skillFixture("review-fix")], [{ message: "Some skills failed", path: "/bad" }]),
    );

    const { result } = renderHook(
      () => useSkillCatalog({ cwd: "/workspace", enabled: true, invalidationGeneration: 0 }),
      { wrapper: queryWrapper() },
    );

    await waitFor(() => expect(result.current.error).toBe("Some skills failed"));
    expect(result.current.skills.map((skill) => skill.name)).toEqual(["review-fix"]);
  });
});
