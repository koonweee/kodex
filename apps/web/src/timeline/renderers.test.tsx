import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const reactMarkdownRenderSpy = vi.hoisted(() => vi.fn());

vi.mock("react-markdown", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-markdown")>();
  const React = await import("react");
  return {
    ...actual,
    default: (props: Parameters<typeof actual.default>[0]) => {
      reactMarkdownRenderSpy(props.children);
      return React.createElement(actual.default, props);
    },
  };
});

import { TimelineActivityGroupRenderer, TimelineFileChangesRenderer, TimelineItemRenderer, TimelineWorkRowRenderer } from "./renderers";
import type { MarkdownPreviewRequest } from "../files/types";
import { createKodexMantineTheme, getKodexColorScheme } from "../theme";
import type { TimelineItem } from "./reducer";

function item(overrides: Partial<TimelineItem>): TimelineItem {
  return {
    id: "item-1",
    kind: "agent_message",
    status: "completed",
    text: "",
    turnId: "turn-1",
    displayOrder: 1,
    payload: {},
    debugEvents: [],
    ...overrides,
  };
}

function mockClipboardWriteText() {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  return writeText;
}

function mockMissingClipboardWriteText() {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: undefined,
  });
}

function openDetails(details: HTMLDetailsElement) {
  details.open = true;
  fireEvent(details, new Event("toggle"));
}

describe("timeline renderer registry", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    reactMarkdownRenderSpy.mockClear();
  });

  it("renders command, file change, warning, error, and unknown items through one registry", () => {
    render(
      <MantineProvider>
        <TimelineItemRenderer item={item({ kind: "command_execution", payload: { command: "cargo test" } })} />
        <TimelineItemRenderer item={item({ id: "item-2", kind: "file_change", payload: { path: "src/App.tsx" } })} />
        <TimelineItemRenderer item={item({ id: "item-3", kind: "warning", text: "Low trust" })} />
        <TimelineItemRenderer item={item({ id: "item-4", kind: "error", text: "Boom" })} />
        <TimelineItemRenderer item={item({ id: "item-5", kind: "future_item", payload: { ok: true } })} />
      </MantineProvider>,
    );

    expect(screen.getByText(/cargo test/i)).toBeInTheDocument();
    expect(screen.getAllByText(/file change/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/modified src\/app\.tsx/i)).toBeInTheDocument();
    expect(screen.getByText(/low trust/i)).toBeInTheDocument();
    expect(screen.getByText(/boom/i)).toBeInTheDocument();
    expect(screen.getByText(/future_item/i)).toBeInTheDocument();
  });

  it("marks failed command activity in collapsed and expanded command renderings", () => {
    render(
      <MantineProvider>
        <TimelineActivityGroupRenderer
          items={[
            item({
              command: "ls missing-file",
              kind: "command_execution",
              output: "ls: missing-file: No such file or directory",
              status: "failed",
            }),
          ]}
        />
      </MantineProvider>,
    );

    const commandDetails = document.querySelector("details.kodex-activity-item");
    expect(commandDetails).toBeInTheDocument();
    expect(within(commandDetails as HTMLElement).getAllByText(/failed/i)).not.toHaveLength(0);
    expect(within(commandDetails as HTMLElement).queryByText(/success/i)).not.toBeInTheDocument();
  });

  it("renders file change output as an inspectable unified diff", () => {
    render(
      <MantineProvider>
        <TimelineItemRenderer
          item={item({
            action: "Modified",
            kind: "file_change",
            output: "@@ -1 +1 @@\n-old\n+new",
            path: "timeline-rendering-feedback.md",
          })}
        />
      </MantineProvider>,
    );

    expect(screen.getByLabelText(/file diff for timeline-rendering-feedback\.md/i)).toBeInTheDocument();
    expect(screen.queryByText("update")).not.toBeInTheDocument();
    expect(screen.queryByText("timeline-rendering-feedback.md")).not.toBeInTheDocument();
    expect(screen.getByText("old")).toBeInTheDocument();
    expect(screen.getByText("new")).toBeInTheDocument();
  });

  it("defers activity item body rendering until the row is opened", () => {
    const { container } = render(
      <MantineProvider>
        <TimelineActivityGroupRenderer
          showDebug
          items={[
            item({
              action: "Modified",
              debugEvents: [
                {
                  id: "event-1",
                  seq: 1,
                  kind: "gateway.warning",
                  codexMethod: "item/completed",
                  threadId: "thread-1",
                  turnId: "turn-1",
                  itemId: "file-1",
                  projectId: "project-1",
                  payload: { output: "diff body" },
                  receivedAt: "2026-04-30T00:00:00Z",
                },
              ],
              id: "file-1",
              kind: "file_change",
              output: "@@ -1 +1 @@\n-old\n+new",
              path: "timeline-rendering-feedback.md",
            }),
          ]}
        />
      </MantineProvider>,
    );

    expect(screen.getByText("Modified timeline-rendering-feedback.md")).toBeInTheDocument();
    expect(screen.queryByLabelText(/file diff for timeline-rendering-feedback\.md/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/item\/completed/i)).not.toBeInTheDocument();

    const activityDetails = container.querySelector("details.kodex-activity-item") as HTMLDetailsElement;
    openDetails(activityDetails);

    expect(screen.getByLabelText(/file diff for timeline-rendering-feedback\.md/i)).toBeInTheDocument();
    expect(screen.getByText(/item\/completed/i)).toBeInTheDocument();
  });

  it("renders aggregated file changes and expands diffs only for modified files", () => {
    const { container } = render(
      <MantineProvider>
        <TimelineFileChangesRenderer
          entries={[
            {
              id: "file-added",
              action: "Added",
              additions: 1,
              deletions: 0,
              diff: "+new file contents",
              itemIds: ["file-added"],
              path: "src/new.ts",
            },
            {
              id: "file-deleted",
              action: "Deleted",
              additions: 0,
              deletions: 1,
              diff: "-old file contents",
              itemIds: ["file-deleted"],
              path: "src/old.ts",
            },
            {
              id: "file-modified",
              action: "Modified",
              additions: 2,
              deletions: 2,
              diff: "@@ -1 +1 @@\n-old\n+new\n@@ -4 +4 @@\n-before\n+after",
              itemIds: ["file-modified", "file-modified-again"],
              path: "src/App.tsx",
            },
          ]}
        />
      </MantineProvider>,
    );

    expect(screen.getByText("3 files changed")).toBeInTheDocument();
    expect(screen.getByText("Added")).toBeInTheDocument();
    expect(screen.getByText("src/new.ts")).toBeInTheDocument();
    expect(screen.getByText("Deleted")).toBeInTheDocument();
    expect(screen.getByText("src/old.ts")).toBeInTheDocument();
    expect(screen.getByText("Modified")).toBeInTheDocument();
    expect(screen.getByText("src/App.tsx")).toBeInTheDocument();
    expect(container.querySelectorAll("details.kodex-file-change-entry")).toHaveLength(1);
    expect(screen.queryByLabelText(/file diff for src\/new\.ts/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/file diff for src\/old\.ts/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/file diff for src\/app\.tsx/i)).not.toBeInTheDocument();

    openDetails(container.querySelector("details.kodex-file-change-entry") as HTMLDetailsElement);

    expect(screen.getByLabelText(/file diff for src\/app\.tsx/i)).toBeInTheDocument();
  });

  it("hides message headings, hides normal completed status, and keeps raw payloads out of the default view", () => {
    render(
      <MantineProvider>
        <TimelineItemRenderer
          item={item({
            kind: "assistant_message",
            text: "Done.",
            payload: { item: { type: "agentMessage", text: "Done." } },
            debugEvents: [
              {
                id: "event-1",
                seq: 1,
                kind: "gateway.warning",
                codexMethod: "item/completed",
                threadId: "thread-1",
                turnId: "turn-1",
                itemId: "item-1",
                projectId: "project-1",
                payload: { item: { type: "agentMessage", text: "Done." } },
                receivedAt: "2026-04-30T00:00:00Z",
              },
            ],
          })}
        />
      </MantineProvider>,
    );

    expect(screen.queryByText("Assistant")).not.toBeInTheDocument();
    expect(screen.getByText("Done.")).toBeInTheDocument();
    expect(screen.queryByText(/assistant_message/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/completed/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/agentMessage/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/item\/completed/i)).not.toBeInTheDocument();
  });

  it("renders user image thumbnails above the message bubble", () => {
    const onImageOpen = vi.fn();
    render(
      <MantineProvider>
        <TimelineItemRenderer
          imagePreviewUrlsByPath={{ "/tmp/diagram.png": "blob:kodex-test" }}
          onImageOpen={onImageOpen}
          item={item({
            kind: "user_message",
            text: "Inspect this",
            images: [{ path: "/tmp/diagram.png" }],
          })}
        />
      </MantineProvider>,
    );

    expect(screen.getByText("Inspect this")).toBeInTheDocument();
    expect(document.querySelector(".kodex-user-image-grid img")).toHaveAttribute("src", "blob:kodex-test");
    fireEvent.click(screen.getByRole("button", { name: /open \/tmp\/diagram\.png/i }));
    expect(onImageOpen).toHaveBeenCalledWith({
      alt: "",
      src: "blob:kodex-test",
      title: "/tmp/diagram.png",
    });
  });

  it("falls back to the file preview endpoint for reloaded user message images", () => {
    render(
      <MantineProvider>
        <TimelineItemRenderer
          threadId="thread-1"
          imagePreviewUrlsByPath={{}}
          item={item({
            kind: "user_message",
            text: "Inspect this",
            images: [{ path: "/tmp/diagram.png" }],
          })}
        />
      </MantineProvider>,
    );

    expect(screen.getByText("Inspect this")).toBeInTheDocument();
    expect(document.querySelector(".kodex-user-image-grid img")?.getAttribute("src")).toContain(
      `/v1/threads/thread-1/files/preview?path=${encodeURIComponent("/tmp/diagram.png")}`,
    );
  });

  it("copies user message text from the user-aligned toolbar", async () => {
    const writeText = mockClipboardWriteText();
    const { container } = render(
      <MantineProvider>
        <TimelineItemRenderer
          item={item({
            kind: "user_message",
            text: "Inspect this exact text",
          })}
        />
      </MantineProvider>,
    );

    expect(container.querySelector('.kodex-message-toolbar[data-align="end"]')).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /copy message/i }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("Inspect this exact text"));
    expect(screen.getByRole("button", { name: /copied message/i })).toBeInTheDocument();
    expect(container.querySelector(".lucide-check")).toBeInTheDocument();
  });

  it("renders the user timestamp before the copy button", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 4, 13, 12, 0, 0));
    const { container } = render(
      <MantineProvider>
        <TimelineItemRenderer
          item={item({
            kind: "user_message",
            text: "Inspect this exact text",
            timestampMs: new Date(2026, 4, 13, 9, 8, 7).getTime(),
          })}
          toolbarTimestampMs={new Date(2026, 4, 13, 9, 8, 7).getTime()}
        />
      </MantineProvider>,
    );

    const toolbar = container.querySelector(".kodex-message-toolbar");
    const timestamp = screen.getByText("9:08:07 AM");
    const copyButton = screen.getByRole("button", { name: /copy message/i });
    expect(toolbar).toContainElement(timestamp);
    expect(toolbar).toContainElement(copyButton);
    expect(timestamp.compareDocumentPosition(copyButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("renders user skill mentions as inline badges from structured ranges only", () => {
    const { container } = render(
      <MantineProvider>
        <TimelineItemRenderer
          item={item({
            kind: "user_message",
            text: "Use $agent-browser now",
            skillMentions: [
              {
                start: "Use ".length,
                end: "Use $agent-browser".length,
                name: "agent-browser",
                path: "/skills/agent-browser/SKILL.md",
              },
            ],
          })}
        />
      </MantineProvider>,
    );

    const badge = screen.getByLabelText("$agent-browser skill");
    expect(badge).toHaveTextContent("$agent-browser");
    expect(badge).toHaveClass("kodex-inline-skill-badge");
    expect(container.querySelector(".kodex-user-message-bubble")).toHaveTextContent("Use $agent-browser now");
  });

  it("renders enriched skill mention display name, tooltip, filled accent, and icon", () => {
    render(
      <MantineProvider>
        <TimelineItemRenderer
          item={item({
            kind: "user_message",
            text: "Use $agent-browser now",
            skillMentions: [
              {
                start: "Use ".length,
                end: "Use $agent-browser".length,
                name: "agent-browser",
                path: "/skills/agent-browser/SKILL.md",
                displayName: "Agent Browser",
                scope: "user",
                shortDescription: "Browser automation",
                brandColor: "#23a55a",
                iconSmallUrl: "/v1/skills/icon?path=%2Fskills%2Fagent-browser%2Ficon.png",
              },
            ],
          })}
        />
      </MantineProvider>,
    );

    const badge = screen.getByLabelText("Agent Browser skill");
    expect(badge).toHaveTextContent("Agent Browser");
    expect(badge).toHaveAttribute(
      "title",
      "Browser automation · user · /skills/agent-browser/SKILL.md",
    );
    expect(badge).toHaveAttribute("data-has-accent", "true");
    expect((badge as HTMLElement).style.getPropertyValue("--skill-accent-color")).toBe("#23a55a");
    expect((badge as HTMLElement).style.getPropertyValue("--skill-accent-foreground")).toBe("#ffffff");
    expect(badge.querySelector("img")).toHaveAttribute(
      "src",
      "/v1/skills/icon?path=%2Fskills%2Fagent-browser%2Ficon.png",
    );
    expect(badge.querySelector("img")).toHaveAttribute("alt", "");
  });

  it("renders enriched svg skill mention icons as themed masks", () => {
    render(
      <MantineProvider>
        <TimelineItemRenderer
          item={item({
            kind: "user_message",
            text: "Use $github:github now",
            skillMentions: [
              {
                start: "Use ".length,
                end: "Use $github:github".length,
                name: "github:github",
                path: "/skills/github/SKILL.md",
                displayName: "GitHub",
                brandColor: "#24292f",
                iconSmallUrl: "/v1/skills/icon?path=%2Fskills%2Fgithub%2Fgithub-small.svg",
              },
            ],
          })}
        />
      </MantineProvider>,
    );

    const badge = screen.getByLabelText("GitHub skill");
    const svgIcon = badge.querySelector(".kodex-inline-skill-icon-svg") as HTMLElement;
    expect(badge).toHaveTextContent("GitHub");
    expect(badge).toHaveAttribute("data-has-accent", "true");
    expect(badge.querySelector("img")).not.toBeInTheDocument();
    expect(svgIcon).toBeInTheDocument();
    expect(svgIcon.style.getPropertyValue("--skill-icon-mask")).toContain("github-small.svg");
  });

  it("uses dark text on light filled skill accent colors", () => {
    render(
      <MantineProvider>
        <TimelineItemRenderer
          item={item({
            kind: "user_message",
            text: "Use $google-drive:google-slides now",
            skillMentions: [
              {
                start: "Use ".length,
                end: "Use $google-drive:google-slides".length,
                name: "google-drive:google-slides",
                path: "/skills/google-slides/SKILL.md",
                displayName: "Google Slides",
                brandColor: "#F9AB00",
              },
            ],
          })}
        />
      </MantineProvider>,
    );

    const badge = screen.getByLabelText("Google Slides skill");
    expect(badge).toHaveTextContent("Google Slides");
    expect((badge as HTMLElement).style.getPropertyValue("--skill-accent-color")).toBe("#F9AB00");
    expect((badge as HTMLElement).style.getPropertyValue("--skill-accent-foreground")).toBe("#17211f");
    const fallbackIcon = badge.querySelector(".kodex-inline-skill-icon-fallback");
    expect(fallbackIcon).toHaveTextContent("G");
    expect(badge.querySelector("img")).not.toBeInTheDocument();
  });

  it("renders enriched skill names without a dollar prefix when display names are absent", () => {
    render(
      <MantineProvider>
        <TimelineItemRenderer
          item={item({
            kind: "user_message",
            text: "Run $restart-prod-tmux",
            skillMentions: [
              {
                start: "Run ".length,
                end: "Run $restart-prod-tmux".length,
                name: "restart-prod-tmux",
                path: "/skills/restart-prod-tmux/SKILL.md",
                scope: "project",
              },
            ],
          })}
        />
      </MantineProvider>,
    );

    const badge = screen.getByLabelText("restart-prod-tmux skill");
    expect(badge).toHaveTextContent("restart-prod-tmux");
    expect(badge).not.toHaveTextContent("$restart-prod-tmux");
  });

  it("ignores invalid skill badge brand colors", () => {
    render(
      <MantineProvider>
        <TimelineItemRenderer
          item={item({
            kind: "user_message",
            text: "Use $agent-browser now",
            skillMentions: [
              {
                start: "Use ".length,
                end: "Use $agent-browser".length,
                name: "agent-browser",
                path: "/skills/agent-browser/SKILL.md",
                brandColor: "not a color",
              },
            ],
          })}
        />
      </MantineProvider>,
    );

    const badge = screen.getByLabelText("$agent-browser skill");
    expect(badge).not.toHaveAttribute("data-has-accent");
    expect((badge as HTMLElement).style.getPropertyValue("--skill-accent-color")).toBe("");
  });

  it("does not badge invalid or unstructured user skill-looking text", () => {
    const { container, rerender } = render(
      <MantineProvider>
        <TimelineItemRenderer
          item={item({
            kind: "user_message",
            text: "Use $agent-browser now",
          })}
        />
      </MantineProvider>,
    );
    expect(container.querySelector(".kodex-inline-skill-badge")).not.toBeInTheDocument();

    rerender(
      <MantineProvider>
        <TimelineItemRenderer
          item={item({
            kind: "user_message",
            text: "Use $agent-browser now",
            skillMentions: [
              {
                start: "Use ".length,
                end: "Use $agent-browser".length,
                name: "other-skill",
                path: "/skills/other/SKILL.md",
              },
            ],
          })}
        />
      </MantineProvider>,
    );
    expect(container.querySelector(".kodex-inline-skill-badge")).not.toBeInTheDocument();
  });

  it("falls back to selection copy when the async Clipboard API is unavailable", async () => {
    mockMissingClipboardWriteText();
    const execCommand = vi.fn().mockReturnValue(true);
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: execCommand,
    });
    const message = "Copy on iPhone over HTTP";

    const { container } = render(
      <MantineProvider>
        <TimelineItemRenderer
          item={item({
            kind: "user_message",
            text: message,
          })}
        />
      </MantineProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: /copy message/i }));

    await waitFor(() => expect(execCommand).toHaveBeenCalledWith("copy"));
    expect(document.querySelector("textarea[readonly]")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /copied message/i })).toBeInTheDocument();
    expect(container.querySelector(".lucide-check")).toBeInTheDocument();
  });

  it("opens displayable image activity thumbnails", () => {
    const onImageOpen = vi.fn();
    render(
      <MantineProvider>
        <TimelineItemRenderer
          onImageOpen={onImageOpen}
          item={item({
            kind: "image_generation",
            path: "https://example.test/generated.png",
            text: "Generated image",
          })}
        />
      </MantineProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: /open https:\/\/example\.test\/generated\.png/i }));
    expect(onImageOpen).toHaveBeenCalledWith({
      alt: "",
      src: "https://example.test/generated.png",
      title: "https://example.test/generated.png",
    });
  });

  it("routes local image activity paths through the thread file preview endpoint", () => {
    const onImageOpen = vi.fn();
    render(
      <MantineProvider>
        <TimelineItemRenderer
          onImageOpen={onImageOpen}
          threadId="thread/with spaces"
          item={item({
            kind: "image_view",
            path: "/Users/example/kodex/preview image.png",
            text: "Viewed image",
          })}
        />
      </MantineProvider>,
    );

    const expectedSrc =
      "http://localhost:3000/v1/threads/thread%2Fwith%20spaces/files/preview?path=%2FUsers%2Fexample%2Fkodex%2Fpreview%20image.png";
    expect(document.querySelector(".kodex-activity-image-preview img")).toHaveAttribute("src", expectedSrc);
    fireEvent.click(screen.getByRole("button", { name: /open \/users\/example\/kodex\/preview image\.png/i }));
    expect(onImageOpen).toHaveBeenCalledWith({
      alt: "",
      src: expectedSrc,
      title: "/Users/example/kodex/preview image.png",
    });
  });

  it("shows a local image preview fallback when the gateway preview cannot load", () => {
    render(
      <MantineProvider>
        <TimelineItemRenderer
          threadId="thread-1"
          item={item({
            kind: "image_view",
            path: "/Users/example/kodex/missing.png",
            text: "Viewed image",
          })}
        />
      </MantineProvider>,
    );

    fireEvent.error(document.querySelector(".kodex-activity-image-preview img") as HTMLImageElement);

    expect(screen.getByText("Preview unavailable")).toBeInTheDocument();
    expect(screen.getByText(/\/Users\/example\/kodex\/missing\.png/)).toBeInTheDocument();
  });

  it("renders generated image data URLs without showing raw base64 output", () => {
    const onImageOpen = vi.fn();
    render(
      <MantineProvider>
        <TimelineItemRenderer
          threadId="thread-1"
          onImageOpen={onImageOpen}
          item={item({
            kind: "image_generation",
            imageSrc: "data:image/png;base64,iVBORw0KGgo=",
            path: "/tmp/generated.png",
            resultSummary: "A diagram",
            text: "Generated image",
          })}
        />
      </MantineProvider>,
    );

    expect(screen.queryByText(/iVBORw0KGgo=/)).not.toBeInTheDocument();
    expect(screen.getByText("Generated image")).toBeInTheDocument();
    const details = document.querySelector(".kodex-image-activity-details");
    expect(details).toBeInTheDocument();
    expect(details).not.toHaveAttribute("open");
    expect(screen.getByText("Details")).toBeInTheDocument();
    expect(screen.getByText(/Path: \/tmp\/generated\.png/)).toBeInTheDocument();
    expect(screen.getByText(/Prompt: A diagram/)).toBeInTheDocument();
    expect(document.querySelector(".kodex-activity-image-preview img")).toHaveAttribute(
      "src",
      "data:image/png;base64,iVBORw0KGgo=",
    );
    fireEvent.click(screen.getByRole("button", { name: /open \/tmp\/generated\.png/i }));
    expect(onImageOpen).toHaveBeenCalledWith({
      alt: "",
      src: "data:image/png;base64,iVBORw0KGgo=",
      title: "/tmp/generated.png",
    });
  });

  it("renders subtle optimistic user message status", () => {
    render(
      <MantineProvider>
        <TimelineItemRenderer
          item={item({
            kind: "user_message",
            text: "Ship it",
            source: "optimistic",
            confirmationState: "sending",
          })}
        />
      </MantineProvider>,
    );

    expect(screen.getByText("Ship it")).toBeInTheDocument();
    expect(screen.getByText("Sending")).toBeInTheDocument();
  });

  it("renders user messages as a right-aligned bubble and preserves newlines", () => {
    const { container } = render(
      <MantineProvider>
        <TimelineItemRenderer
          item={item({
            kind: "user_message",
            text: "First line\nSecond line",
            payload: { item: { type: "userMessage", text: "First line\nSecond line" } },
          })}
        />
      </MantineProvider>,
    );

    const bubble = container.querySelector<HTMLElement>(".kodex-user-message-bubble");
    const row = container.querySelector<HTMLElement>(".kodex-user-message-row");
    expect(screen.queryByText("You")).not.toBeInTheDocument();
    expect(bubble).toBeInTheDocument();
    expect(bubble?.textContent).toBe("First line\nSecond line");
    expect(row).toContainElement(bubble);
    expect(container.querySelector(".kodex-timeline-item-header")).not.toBeInTheDocument();
  });

  it("renders assistant messages as safe markdown", () => {
    render(
      <MantineProvider>
        <TimelineItemRenderer
          item={item({
            kind: "assistant_message",
            text:
              "For ZIP `94123`:\n\n- `52.8°F`, feels like `50.2°F`\n- Fog\n\nSource: [Open-Meteo](https://open-meteo.com/en/docs)\n\n<script>alert('x')</script>",
          })}
        />
      </MantineProvider>,
    );

    expect(screen.getByText("94123").tagName.toLowerCase()).toBe("code");
    expect(screen.getByRole("list")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByRole("link", { name: /open-meteo/i })).toHaveAttribute(
      "href",
      "https://open-meteo.com/en/docs",
    );
    expect(screen.getByRole("link", { name: /open-meteo/i })).toHaveAttribute("rel", "noreferrer");
    expect(screen.queryByText(/alert/i)).not.toBeInTheDocument();
  });

  it("rewrites local markdown links to the thread file preview endpoint", () => {
    render(
      <MantineProvider>
        <TimelineItemRenderer
          threadId="thread-1"
          item={item({
            kind: "assistant_message",
            text:
              "Read [notes](/Users/example/kodex/NOTES.markdown), [section](/Users/example/kodex/Guide.md#intro), and [web](https://example.com/readme.md).",
          })}
        />
      </MantineProvider>,
    );

    expect(screen.getByRole("link", { name: "notes" })).toHaveAttribute(
      "href",
      "http://localhost:3000/v1/threads/thread-1/files/preview?path=%2FUsers%2Fexample%2Fkodex%2FNOTES.markdown",
    );
    expect(screen.getByRole("link", { name: "notes" })).toHaveAttribute("download", "NOTES.markdown");
    expect(screen.getByRole("link", { name: "section" })).toHaveAttribute(
      "href",
      "http://localhost:3000/v1/threads/thread-1/files/preview?path=%2FUsers%2Fexample%2Fkodex%2FGuide.md#intro",
    );
    expect(screen.getByRole("link", { name: "section" })).toHaveAttribute("download", "Guide.md");
    expect(screen.getByRole("link", { name: "web" })).toHaveAttribute("href", "https://example.com/readme.md");
    expect(screen.queryByText(/NOTES\.markdown content/i)).not.toBeInTheDocument();
  });

  it("rewrites line-suffixed local markdown links and keeps the source location for preview callbacks", () => {
    const onMarkdownOpen = vi.fn<(request: MarkdownPreviewRequest) => void>();
    render(
      <MantineProvider>
        <TimelineItemRenderer
          onMarkdownOpen={onMarkdownOpen}
          threadId="thread-1"
          item={item({
            kind: "assistant_message",
            text:
              "Read [indexed](/Users/example/kodex/plans/index.md:42), [column](/Users/example/kodex/plans/index.md:42:7), and [web](https://example.com/readme.md:42).",
          })}
        />
      </MantineProvider>,
    );

    expect(screen.getByRole("link", { name: "indexed" })).toHaveAttribute(
      "href",
      "http://localhost:3000/v1/threads/thread-1/files/preview?path=%2FUsers%2Fexample%2Fkodex%2Fplans%2Findex.md",
    );
    expect(screen.getByRole("link", { name: "column" })).toHaveAttribute(
      "href",
      "http://localhost:3000/v1/threads/thread-1/files/preview?path=%2FUsers%2Fexample%2Fkodex%2Fplans%2Findex.md",
    );
    expect(screen.getByRole("link", { name: "web" })).toHaveAttribute("href", "https://example.com/readme.md:42");

    fireEvent.click(screen.getByRole("link", { name: "column" }));

    expect(onMarkdownOpen).toHaveBeenCalledWith({
      column: 7,
      fragment: "",
      href: "http://localhost:3000/v1/threads/thread-1/files/preview?path=%2FUsers%2Fexample%2Fkodex%2Fplans%2Findex.md",
      line: 42,
      path: "/Users/example/kodex/plans/index.md",
      title: "index.md:42:7",
    });
  });

  it("opens local markdown links through the markdown preview callback on normal click", () => {
    const onMarkdownOpen = vi.fn<(request: MarkdownPreviewRequest) => void>();
    render(
      <MantineProvider>
        <TimelineItemRenderer
          onMarkdownOpen={onMarkdownOpen}
          threadId="thread-1"
          item={item({
            kind: "assistant_message",
            text: "Read [feedback](/Users/example/kodex/timeline-rendering-feedback.md#notes).",
          })}
        />
      </MantineProvider>,
    );

    const link = screen.getByRole("link", { name: "feedback" });
    fireEvent.click(link);

    expect(onMarkdownOpen).toHaveBeenCalledWith({
      fragment: "#notes",
      href: "http://localhost:3000/v1/threads/thread-1/files/preview?path=%2FUsers%2Fexample%2Fkodex%2Ftimeline-rendering-feedback.md#notes",
      path: "/Users/example/kodex/timeline-rendering-feedback.md",
      title: "timeline-rendering-feedback.md",
    });
  });

  it("preserves browser-native modifier-click behavior for local markdown links", () => {
    const onMarkdownOpen = vi.fn<(request: MarkdownPreviewRequest) => void>();
    render(
      <MantineProvider>
        <TimelineItemRenderer
          onMarkdownOpen={onMarkdownOpen}
          threadId="thread-1"
          item={item({
            kind: "assistant_message",
            text: "Read [feedback](/Users/example/kodex/timeline-rendering-feedback.md).",
          })}
        />
      </MantineProvider>,
    );

    fireEvent.click(screen.getByRole("link", { name: "feedback" }), { metaKey: true });

    expect(onMarkdownOpen).not.toHaveBeenCalled();
  });

  it("opens local assistant markdown image links in the image viewer through the thread file preview endpoint", () => {
    const onImageOpen = vi.fn();
    render(
      <MantineProvider>
        <TimelineItemRenderer
          onImageOpen={onImageOpen}
          threadId="thread-1"
          item={item({
            kind: "assistant_message",
            text:
              "Evidence: [03-inline-review-toast.png](/Users/example/reference-project/dogfood-output/transaction-review/screenshots/03-inline-review-toast.png).",
          })}
        />
      </MantineProvider>,
    );

    const expectedHref =
      "http://localhost:3000/v1/threads/thread-1/files/preview?path=%2FUsers%2Fexample%2Freference-project%2Fdogfood-output%2Ftransaction-review%2Fscreenshots%2F03-inline-review-toast.png";
    const link = screen.getByRole("link", { name: "03-inline-review-toast.png" });
    expect(link).toHaveAttribute("href", expectedHref);
    expect(link).not.toHaveAttribute("download");

    fireEvent.click(link);

    expect(onImageOpen).toHaveBeenCalledWith({
      alt: "",
      src: expectedHref,
      title:
        "/Users/example/reference-project/dogfood-output/transaction-review/screenshots/03-inline-review-toast.png",
    });
  });

  it("copies final assistant message markdown from the assistant-aligned toolbar", async () => {
    const writeText = mockClipboardWriteText();
    const markdown = "Use **bold** and `code`.\n\n- Keep markdown";
    const { container } = render(
      <MantineProvider>
        <TimelineItemRenderer
          item={item({
            kind: "assistant_message",
            messagePhase: "final_answer",
            text: markdown,
          })}
        />
      </MantineProvider>,
    );

    expect(container.querySelector('.kodex-message-toolbar[data-align="start"]')).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /copy message/i }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(markdown));
    expect(screen.getByRole("button", { name: /copied message/i })).toBeInTheDocument();
    expect(container.querySelector(".lucide-check")).toBeInTheDocument();
  });

  it("renders the assistant timestamp after the copy button", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 4, 13, 12, 0, 0));
    const timestampMs = new Date(2026, 4, 12, 9, 8, 7).getTime();
    const { container } = render(
      <MantineProvider>
        <TimelineItemRenderer
          item={item({
            kind: "assistant_message",
            messagePhase: "final_answer",
            text: "Use **bold**.",
            timestampMs,
          })}
          toolbarTimestampMs={timestampMs}
        />
      </MantineProvider>,
    );

    const toolbar = container.querySelector(".kodex-message-toolbar");
    const timestamp = screen.getByText("yesterday 9:08:07 AM");
    const copyButton = screen.getByRole("button", { name: /copy message/i });
    expect(toolbar).toContainElement(timestamp);
    expect(toolbar).toContainElement(copyButton);
    expect(copyButton.compareDocumentPosition(timestamp) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("does not render copy controls for non-final assistant messages", () => {
    render(
      <MantineProvider>
        <TimelineItemRenderer
          item={item({
            kind: "assistant_message",
            status: "running",
            text: "Streaming...",
          })}
          toolbarTimestampMs={new Date(2026, 4, 13, 9, 8, 7).getTime()}
        />
      </MantineProvider>,
    );

    expect(screen.queryByRole("button", { name: /copy message/i })).not.toBeInTheDocument();
    expect(screen.queryByText("9:08:07 AM")).not.toBeInTheDocument();
  });

  it("keeps assistant markdown output stable for links, code, lists, breaks, and skipped HTML", () => {
    const { container, rerender } = render(
      <MantineProvider>
        <TimelineItemRenderer
          item={item({
            kind: "assistant_message",
            text:
              "Use [docs](https://example.com/docs).\nNext line\n\n- one\n- `two`\n\n```ts\nconst value = 1;\n```\n\n<strong>hidden</strong>",
          })}
        />
      </MantineProvider>,
    );
    const initialMarkup = container.querySelector(".kodex-assistant-markdown")?.innerHTML;

    expect(screen.getByRole("link", { name: "docs" })).toHaveAttribute("target", "_blank");
    expect(screen.getByRole("link", { name: "docs" })).toHaveAttribute("rel", "noreferrer");
    expect(screen.getByRole("list")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText("two").tagName.toLowerCase()).toBe("code");
    expect(container.querySelector(".kodex-timeline-code")).toHaveTextContent("const value = 1;");
    expect(container.querySelector(".kodex-assistant-markdown br")).toBeInTheDocument();
    expect(container.querySelector(".kodex-assistant-markdown strong")).not.toBeInTheDocument();

    rerender(
      <MantineProvider>
        <TimelineItemRenderer
          item={item({
            kind: "assistant_message",
            text:
              "Use [docs](https://example.com/docs).\nNext line\n\n- one\n- `two`\n\n```ts\nconst value = 1;\n```\n\n<strong>hidden</strong>",
          })}
        />
      </MantineProvider>,
    );

    expect(container.querySelector(".kodex-assistant-markdown")?.innerHTML).toBe(initialMarkup);
  });

  it("renders assistant markdown tables in a scrollable themed shell with GFM alignment", () => {
    const { container } = render(
      <MantineProvider theme={createKodexMantineTheme(getKodexColorScheme("oled-black"))}>
        <TimelineItemRenderer
          item={item({
            kind: "assistant_message",
            text: [
              "| Path | Status | Count |",
              "| :--- | :---: | ---: |",
              "| `apps/web/src/App.tsx` | Ready | 12 |",
            ].join("\n"),
          })}
        />
      </MantineProvider>,
    );

    const tableShell = container.querySelector(".kodex-markdown-table-scroll");
    const table = within(tableShell as HTMLElement).getByRole("table");
    const headers = within(table).getAllByRole("columnheader");
    const cells = within(table).getAllByRole("cell");

    expect(tableShell).toBeInTheDocument();
    expect(table).toHaveClass("kodex-mantine-table");
    expect(headers.map((header) => header.textContent)).toEqual(["Path", "Status", "Count"]);
    expect(headers[0]).toHaveStyle({ textAlign: "left" });
    expect(headers[1]).toHaveStyle({ textAlign: "center" });
    expect(headers[2]).toHaveStyle({ textAlign: "right" });
    expect(cells[0]).toHaveTextContent("apps/web/src/App.tsx");
    expect(cells[1]).toHaveStyle({ textAlign: "center" });
    expect(cells[2]).toHaveStyle({ textAlign: "right" });
  });

  it("renders unlabeled fenced code blocks as block code", () => {
    const { container } = render(
      <MantineProvider>
        <TimelineItemRenderer
          item={item({
            kind: "assistant_message",
            text: "Run this:\n\n```\nnpm test\n```",
          })}
        />
      </MantineProvider>,
    );

    const codeBlock = container.querySelector(".kodex-timeline-code");
    expect(codeBlock).toHaveTextContent("npm test");
    expect(container.querySelector(".kodex-assistant-inline-code")).not.toBeInTheDocument();
  });

  it("copies fenced code block text from the block copy button", async () => {
    const writeText = mockClipboardWriteText();
    render(
      <MantineProvider>
        <TimelineItemRenderer
          item={item({
            kind: "assistant_message",
            text: "Use `inline` first.\n\n```sh\nnpm test\n```",
          })}
        />
      </MantineProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: /copy code/i }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("npm test"));
    expect(screen.getByRole("button", { name: /copied code/i })).toBeInTheDocument();
    expect(screen.getByText("inline").closest("button")).not.toBeInTheDocument();
  });

  it("does not reparse completed assistant markdown on unrelated parent rerenders", () => {
    const completedItem = item({
      kind: "assistant_message",
      status: "completed",
      text: "Done with [docs](https://example.com).",
    });
    const CompletedHarness = ({ tick }: { tick: number }) => (
      <MantineProvider>
        <div data-testid="tick">{tick}</div>
        <TimelineItemRenderer item={{ ...completedItem }} />
      </MantineProvider>
    );

    const { rerender } = render(<CompletedHarness tick={0} />);
    expect(reactMarkdownRenderSpy).toHaveBeenCalledTimes(1);
    reactMarkdownRenderSpy.mockClear();

    rerender(<CompletedHarness tick={1} />);

    expect(screen.getByTestId("tick")).toHaveTextContent("1");
    expect(screen.getByRole("link", { name: "docs" })).toBeInTheDocument();
    expect(reactMarkdownRenderSpy).not.toHaveBeenCalled();
  });

  it("updates streaming assistant markdown when message text changes", () => {
    const StreamingHarness = ({ text }: { text: string }) => (
      <MantineProvider>
        <TimelineItemRenderer
          item={item({
            kind: "assistant_message",
            status: "running",
            text,
          })}
        />
      </MantineProvider>
    );

    const { container, rerender } = render(<StreamingHarness text="Checking..." />);
    expect(screen.getByText("Checking...")).toBeInTheDocument();
    expect(screen.queryByText("running")).not.toBeInTheDocument();
    reactMarkdownRenderSpy.mockClear();

    rerender(<StreamingHarness text={"Checking...\nFound source."} />);

    expect(container.querySelector(".kodex-assistant-markdown")).toHaveTextContent("Checking...");
    expect(container.querySelector(".kodex-assistant-markdown")).toHaveTextContent("Found source.");
    expect(container.querySelector(".kodex-assistant-markdown br")).toBeInTheDocument();
    expect(reactMarkdownRenderSpy).toHaveBeenCalledTimes(1);
  });

  it("preserves assistant markdown soft line breaks during streaming", () => {
    const { container } = render(
      <MantineProvider>
        <TimelineItemRenderer
          item={item({
            kind: "assistant_message",
            status: "running",
            text: "Checking current conditions...\nSearching source results...",
          })}
        />
      </MantineProvider>,
    );

    expect(container.querySelector(".kodex-assistant-markdown br")).toBeInTheDocument();
  });

  it("renders reasoning and web search as compact structured blocks", async () => {
    render(
      <MantineProvider>
        <TimelineItemRenderer
          item={item({
            id: "reasoning-1",
            kind: "reasoning_summary",
            summary: "Need current sources.",
            payload: { item: { type: "reasoning", summary: "Need current sources." } },
          })}
        />
        <TimelineItemRenderer
          item={item({
            id: "web-search-turn-1",
            kind: "web_search_group",
            actions: [
              { kind: "search", query: "Codex app server" },
              { kind: "open", title: "Example", url: "https://example.com" },
            ],
            payload: {},
          })}
        />
      </MantineProvider>,
    );

    expect(screen.getByText("Reasoning")).toBeInTheDocument();
    expect(screen.getByText("Web search")).toBeInTheDocument();
    expect(screen.getByText(/searched web for/i)).toBeInTheDocument();
    expect(screen.getByText(/codex app server/i)).toBeInTheDocument();
    expect(screen.getByText(/opened page/i)).toBeInTheDocument();
    expect(screen.getByText(/example/i)).toBeInTheDocument();
    expect(screen.queryByText(/"query"/i)).not.toBeInTheDocument();
  });

  it("renders supporting timeline activity as a nested collapsible group", () => {
    const { container } = render(
      <MantineProvider>
        <TimelineActivityGroupRenderer
          items={[
            item({
              id: "cmd-1",
              kind: "command_execution",
              command: "pwd",
              cwd: "/home/example/kodex",
              output: "/home/example/kodex\n",
            }),
            item({
              id: "cmd-2",
              kind: "command_execution",
              command: "rg --files",
              output: "apps/web/src/App.tsx\napps/web/src/timeline/renderers.tsx\n",
            }),
            item({
              id: "web-1",
              kind: "web_search_group",
              actions: [{ kind: "search", query: "Codex app server" }],
            }),
            item({
              id: "collab-1",
              kind: "collab_agent_tool_call",
              text: "Finished waiting",
              toolName: "wait",
              resultSummary: "No major issues remain.",
            }),
            item({
              id: "image-1",
              kind: "image_generation",
              text: "Generated image",
              output: "completed",
              path: "/tmp/generated.png",
              resultSummary: "A diagram",
            }),
          ]}
        />
      </MantineProvider>,
    );

    expect(container.querySelector(".kodex-activity-group")).not.toHaveAttribute("open");
    expect(screen.getByText("Searched web, used 1 agent, generated 1 image, ran 2 commands")).toBeInTheDocument();
    expect(screen.getByText("Ran pwd")).toBeInTheDocument();
    expect(screen.getByText("Listed files")).toBeInTheDocument();
    expect(screen.getAllByText("Finished waiting").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Generated image").length).toBeGreaterThan(0);

    const activityItems = Array.from(container.querySelectorAll("details.kodex-activity-item")) as HTMLDetailsElement[];
    activityItems.forEach(openDetails);

    expect(screen.getByText(/no major issues remain/i)).toBeInTheDocument();
    expect(screen.getByText(/\/tmp\/generated\.png/i)).toBeInTheDocument();
    expect(screen.getByText(/Result: completed/i)).toBeInTheDocument();
    expect(screen.getByText("$ pwd")).toBeInTheDocument();
    expect(screen.getByText("/home/example/kodex")).toBeInTheDocument();
    expect(screen.getAllByText("Shell")).not.toHaveLength(0);
  });

  it("renders structured collaboration activity with Markdown result previews", () => {
    const { container } = render(
      <MantineProvider>
        <TimelineItemRenderer
          item={item({
            id: "collab-spawn",
            kind: "collab_agent_tool_call",
            text: "Spawned Lorentz [explorer]",
            toolName: "spawnAgent",
            collab: {
              agents: [{ threadId: "thread-lorentz", displayName: "Lorentz [explorer]", nickname: "Lorentz", role: "explorer" }],
              model: "gpt-5.5",
              reasoningEffort: "high",
              prompt: "Inspect the renderer behavior and summarize the result.",
            },
          })}
        />
        <TimelineItemRenderer
          item={item({
            id: "collab-wait",
            kind: "collab_agent_tool_call",
            text: "Finished waiting",
            toolName: "wait",
            collab: {
              agents: [
                {
                  threadId: "thread-lorentz",
                  displayName: "Lorentz [explorer]",
                  status: "Completed",
                  rawStatus: "completed",
                  message: "**Done**\n\n- checked `renderers.tsx`\n- see [plan](plans/collab-agent-timeline-rendering.md)",
                },
              ],
            },
          })}
        />
      </MantineProvider>,
    );

    expect(screen.getByText("Spawned Lorentz [explorer]")).toBeInTheDocument();
    expect(screen.getByText("gpt-5.5")).toBeInTheDocument();
    expect(screen.getByText("High")).toBeInTheDocument();
    expect(screen.getByText("Inspect the renderer behavior and summarize the result.")).toBeInTheDocument();
    expect(screen.getAllByText("Lorentz [explorer]").length).toBeGreaterThan(0);
    expect(screen.getByText("Completed")).toBeInTheDocument();
    expect(screen.getByText("Done")).toBeInTheDocument();
    expect(screen.getByText("renderers.tsx")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "plan" })).toHaveAttribute(
      "href",
      "plans/collab-agent-timeline-rendering.md",
    );
    expect(reactMarkdownRenderSpy).toHaveBeenCalledWith(expect.stringContaining("**Done**"));
    expect(container).not.toHaveTextContent("thread-lorentz");
  });

  it("summarizes grouped collaboration rows with friendly names and counts", () => {
    const { container } = render(
      <MantineProvider>
        <TimelineActivityGroupRenderer
          items={[
            item({
              id: "collab-spawn",
              kind: "collab_agent_tool_call",
              text: "Spawned Lorentz [explorer]",
              toolName: "spawnAgent",
              collab: {
                agents: [{ threadId: "thread-lorentz", displayName: "Lorentz [explorer]" }],
              },
            }),
            item({
              id: "collab-wait",
              kind: "collab_agent_tool_call",
              text: "Finished waiting",
              toolName: "wait",
              collab: {
                agents: [
                  { threadId: "thread-lorentz", displayName: "Lorentz [explorer]", status: "Completed" },
                  { threadId: "thread-mill", displayName: "Mill", status: "Running" },
                ],
              },
            }),
          ]}
        />
      </MantineProvider>,
    );

    expect(screen.getByText("Used 2 agents")).toBeInTheDocument();
    expect(screen.getByText("Spawned Lorentz [explorer]")).toBeInTheDocument();
    expect(screen.getByText("Finished waiting")).toBeInTheDocument();
    expect(container).not.toHaveTextContent("thread-lorentz");
    expect(container).not.toHaveTextContent("thread-mill");
  });

  it("renders completed work rows as collapse controls without nesting detail rows", async () => {
    const onExpandedChange = vi.fn();
    const workRow = {
      type: "work" as const,
      key: "work-turn-1",
      turnKey: "turn-turn-1",
      turnId: "turn-1",
      state: "completed" as const,
      startedAtMs: 1_000,
      completedAtMs: 65_000,
      displayOrder: 1.1,
      collapsedRows: [
        {
          type: "item" as const,
          key: "item-reasoning-1",
          turnKey: "turn-turn-1",
          turnId: "turn-1",
          displayOrder: 2,
          item: item({
            id: "reasoning-1",
            kind: "reasoning_summary",
            summary: "Need context.",
            text: "Need context.",
            displayOrder: 2,
          }),
        },
      ],
    };
    const { container, rerender } = render(
      <MantineProvider>
        <TimelineWorkRowRenderer
          expanded={false}
          onExpandedChange={onExpandedChange}
          row={workRow}
        />
      </MantineProvider>,
    );

    const details = container.querySelector("details.kodex-work-row");
    expect(details).toBeInTheDocument();
    expect(details).not.toHaveAttribute("open");
    expect(details?.querySelector(".kodex-work-header-divider")).toBeInTheDocument();
    expect(details?.querySelector("summary > .kodex-work-header-divider")).toBeInTheDocument();
    expect(screen.getByText("Worked for 1m 04s")).toBeInTheDocument();
    expect(screen.queryByText("Need context.")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("Worked for 1m 04s"));
    await waitFor(() => expect(onExpandedChange).toHaveBeenCalledWith(true));

    rerender(
      <MantineProvider>
        <TimelineWorkRowRenderer
          expanded
          onExpandedChange={onExpandedChange}
          row={workRow}
        />
      </MantineProvider>,
    );
    expect(container.querySelector("details.kodex-work-row")).toHaveAttribute("open");
    expect(screen.queryByText("Need context.")).not.toBeInTheDocument();
    expect(container.querySelector(".kodex-work-collapsed-rows")).not.toBeInTheDocument();
  });

  it("renders completed work rows without a caret when there is nothing to expand", () => {
    const { container } = render(
      <MantineProvider>
        <TimelineWorkRowRenderer
          row={{
            type: "work",
            key: "work-turn-1",
            turnKey: "turn-turn-1",
            turnId: "turn-1",
            state: "completed",
            startedAtMs: 1_000,
            completedAtMs: 6_000,
            displayOrder: 1.1,
            collapsedRows: [],
          }}
        />
      </MantineProvider>,
    );

    expect(container.querySelector("details.kodex-work-row")).not.toBeInTheDocument();
    expect(container.querySelector(".kodex-work-caret")).not.toBeInTheDocument();
    expect(container.querySelector(".kodex-work-header-divider")).toBeInTheDocument();
    expect(screen.getByText("Worked for 5s")).toBeInTheDocument();
  });

  it("renders running work rows with the header divider", () => {
    const { container } = render(
      <MantineProvider>
        <TimelineWorkRowRenderer
          row={{
            type: "work",
            key: "work-turn-1",
            turnKey: "turn-turn-1",
            turnId: "turn-1",
            state: "running",
            startedAtMs: Date.now(),
            displayOrder: 1.1,
            collapsedRows: [],
          }}
        />
      </MantineProvider>,
    );

    expect(screen.getByText(/Working for/)).toBeInTheDocument();
    expect(container.querySelector(".kodex-work-header-divider")).toBeInTheDocument();
  });

  it("renders running work rows without elapsed time when no canonical start exists", () => {
    render(
      <MantineProvider>
        <TimelineWorkRowRenderer
          row={{
            type: "work",
            key: "work-turn-1",
            turnKey: "turn-turn-1",
            turnId: "turn-1",
            state: "running",
            displayOrder: 1.1,
            collapsedRows: [],
          }}
        />
      </MantineProvider>,
    );

    expect(screen.getByText("Working")).toBeInTheDocument();
    expect(screen.queryByText(/Working for/)).not.toBeInTheDocument();
  });

  it("renders plan, review mode, and context compaction timeline markers", () => {
    render(
      <MantineProvider>
        <TimelineItemRenderer item={item({ id: "plan-1", kind: "plan", text: "1. Inspect\n2. Patch" })} />
        <TimelineItemRenderer
          item={item({
            id: "review-start",
            kind: "review_mode_started",
            text: "Code review started: Review image support",
          })}
        />
        <TimelineItemRenderer
          item={item({
            id: "review-end",
            kind: "review_mode_finished",
            text: "Code review finished",
          })}
        />
        <TimelineItemRenderer
          item={item({
            id: "compact-1",
            kind: "context_compaction",
            text: "Context compacted",
          })}
        />
      </MantineProvider>,
    );

    expect(screen.getByText("Plan")).toBeInTheDocument();
    expect(screen.getByText(/1\. Inspect\s+2\. Patch/)).toBeInTheDocument();
    expect(screen.getByText("Code review started: Review image support")).toBeInTheDocument();
    expect(screen.getByText("Code review finished")).toBeInTheDocument();
    expect(screen.getByText("Context compacted")).toBeInTheDocument();
    expect(screen.queryByText(/Unsupported item/i)).not.toBeInTheDocument();
  });

  it("renders context compaction markers without a row header", () => {
    const { container } = render(
      <MantineProvider>
        <TimelineItemRenderer
          item={item({
            id: "compact-1",
            kind: "context_compaction",
            text: "Context compacted",
          })}
        />
      </MantineProvider>,
    );

    expect(screen.getByText("Context compacted")).toBeInTheDocument();
    expect(screen.queryByText("Context")).not.toBeInTheDocument();
    expect(container.querySelector(".kodex-timeline-item-header")).not.toBeInTheDocument();
  });

  it("keeps long command summaries truncatable while showing the full command in the shell block", () => {
    const command = "/usr/bin/zsh -lc \"sed -n '960,1140p' apps/web/src/App.tsx\"";
    const { container } = render(
      <MantineProvider>
        <TimelineActivityGroupRenderer
          items={[
            item({
              id: "cmd-long",
              kind: "command_execution",
              command,
              cwd: "/home/example/kodex",
              output: "function TimelineView() {}\n",
            }),
          ]}
        />
      </MantineProvider>,
    );

    expect(screen.getByText("Ran sed -n '960,1140p' apps/web/src/App.tsx")).toHaveAttribute(
      "title",
      "Ran sed -n '960,1140p' apps/web/src/App.tsx",
    );

    openDetails(container.querySelector("details.kodex-activity-item") as HTMLDetailsElement);

    expect(screen.getByText("$ sed -n '960,1140p' apps/web/src/App.tsx")).toBeInTheDocument();
    expect(screen.queryByText("/home/example/kodex")).not.toBeInTheDocument();
  });

  it("shows debug event metadata and raw payload only when debug mode is enabled", () => {
    const debugItem = item({
      kind: "debug_event",
      text: "Unsupported item",
      payload: { item: { type: "futureThing", value: true } },
      debugEvents: [
        {
          id: "event-1",
          seq: 1,
          kind: "gateway.warning",
          codexMethod: "item/started",
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "item-1",
          projectId: "project-1",
          payload: { item: { type: "futureThing", value: true } },
          receivedAt: "2026-04-30T00:00:00Z",
        },
      ],
    });

    const { rerender } = render(
      <MantineProvider>
        <TimelineItemRenderer item={debugItem} />
      </MantineProvider>,
    );

    expect(screen.getByText("Unsupported item")).toBeInTheDocument();
    expect(screen.queryByText(/futureThing/i)).not.toBeInTheDocument();

    rerender(
      <MantineProvider>
        <TimelineItemRenderer item={debugItem} showDebug />
      </MantineProvider>,
    );

    expect(screen.getByText(/item\/started/i)).toBeInTheDocument();
    expect(screen.getByText(/futureThing/i)).toBeInTheDocument();
  });
});
