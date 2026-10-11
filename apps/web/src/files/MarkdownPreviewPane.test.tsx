import { MantineProvider } from "@mantine/core";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { GatewayClient } from "../api/gatewayClient";
import {
  ExecutorRuntimeBoundary,
  ExecutorRuntimeProvider,
  ExecutorRuntimeRegistryProvider,
} from "../api/GatewayClientContext";
import { createKodexQueryClient, type ExecutorRuntime } from "../api/queryClient";
import { MarkdownPreviewPane } from "./MarkdownPreviewPane";

function runtime(id: string, fetchThreadFilePreview: GatewayClient["fetchThreadFilePreview"]): ExecutorRuntime {
  return {
    api: { fetchThreadFilePreview } as GatewayClient,
    connection: Object.freeze({ executorId: id, instanceId: `instance-${id}` }),
    queryClient: createKodexQueryClient(),
    storage: null,
  };
}

describe("MarkdownPreviewPane executor ownership", () => {
  it("loads a colliding thread path through the preview's owning executor", async () => {
    const fetchA = vi.fn(async () => "# Executor A");
    const fetchB = vi.fn(async () => "# Executor B");
    const executorA = runtime("executor-a", fetchA);
    const executorB = runtime("executor-b", fetchB);

    render(
      <MantineProvider>
        <ExecutorRuntimeRegistryProvider runtimes={[executorA, executorB]}>
          <ExecutorRuntimeProvider runtime={executorA}>
            <ExecutorRuntimeBoundary executorId="executor-b">
              <MarkdownPreviewPane
                onClose={() => undefined}
                preview={{ href: "notes.md", path: "notes.md", title: "Notes" }}
                threadId="shared"
              />
            </ExecutorRuntimeBoundary>
          </ExecutorRuntimeProvider>
        </ExecutorRuntimeRegistryProvider>
      </MantineProvider>,
    );

    expect(await screen.findByRole("heading", { name: "Executor B" })).toBeInTheDocument();
    expect(fetchB).toHaveBeenCalledWith("shared", "notes.md");
    expect(fetchA).not.toHaveBeenCalled();
  });
});
