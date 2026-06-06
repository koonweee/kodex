import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

import { TimelineItemRenderer } from "./renderers";
import { filePreviewUrl } from "../api/client";
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

describe("timeline message renderers", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    reactMarkdownRenderSpy.mockClear();
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

  it("renders user file attachments above the message bubble", () => {
    render(
      <MantineProvider>
        <TimelineItemRenderer
          item={item({
            kind: "user_message",
            text: "Review this",
            fileAttachments: [
              {
                id: "file-1",
                fileName: "notes.md",
                extension: "md",
                relativePath: ".kodex/uploads/thread-1/file-1-notes.md",
                sizeBytes: 7,
              },
            ],
          })}
        />
      </MantineProvider>,
    );

    expect(screen.getByText("MD")).toBeInTheDocument();
    expect(screen.getByText("notes.md")).toBeInTheDocument();
    expect(screen.getByText("Review this")).toBeInTheDocument();
  });

  it("opens markdown user file attachments in the preview pane", () => {
    const onMarkdownOpen = vi.fn();
    render(
      <MantineProvider>
        <TimelineItemRenderer
          threadId="thread-1"
          onMarkdownOpen={onMarkdownOpen}
          item={item({
            kind: "user_message",
            text: "Review this",
            fileAttachments: [
              {
                id: "file-1",
                fileName: "notes.md",
                extension: "md",
                relativePath: ".kodex/uploads/thread-1/file-1/notes.md",
                sizeBytes: 7,
              },
            ],
          })}
        />
      </MantineProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: /preview notes\.md/i }));

    expect(onMarkdownOpen).toHaveBeenCalledWith({
      href: filePreviewUrl("thread-1", ".kodex/uploads/thread-1/file-1/notes.md"),
      path: ".kodex/uploads/thread-1/file-1/notes.md",
      title: "notes.md",
    });
  });

  it("opens pdf user file attachments in a new tab", () => {
    render(
      <MantineProvider>
        <TimelineItemRenderer
          threadId="thread-1"
          item={item({
            kind: "user_message",
            text: "Review this",
            fileAttachments: [
              {
                id: "file-1",
                fileName: "report.pdf",
                extension: "pdf",
                relativePath: ".kodex/uploads/thread-1/file-1/report.pdf",
                sizeBytes: 42,
              },
            ],
          })}
        />
      </MantineProvider>,
    );

    const link = screen.getByRole("link", { name: /open report\.pdf/i });
    expect(link).toHaveAttribute("href", filePreviewUrl("thread-1", ".kodex/uploads/thread-1/file-1/report.pdf"));
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noreferrer");
  });

  it("downloads other user file attachments", () => {
    render(
      <MantineProvider>
        <TimelineItemRenderer
          threadId="thread-1"
          item={item({
            kind: "user_message",
            text: "Review this",
            fileAttachments: [
              {
                id: "file-1",
                fileName: "data.csv",
                extension: "csv",
                relativePath: ".kodex/uploads/thread-1/file-1/data.csv",
                sizeBytes: 42,
              },
            ],
          })}
        />
      </MantineProvider>,
    );

    const link = screen.getByRole("link", { name: /download data\.csv/i });
    expect(link).toHaveAttribute("href", filePreviewUrl("thread-1", ".kodex/uploads/thread-1/file-1/data.csv"));
    expect(link).toHaveAttribute("download", "data.csv");
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
});
