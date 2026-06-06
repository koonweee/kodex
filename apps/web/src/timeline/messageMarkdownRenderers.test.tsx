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

import { TimelineItemRenderer } from "./renderers";
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

describe("timeline message markdown renderers", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    reactMarkdownRenderSpy.mockClear();
  });

  it("renders assistant messages as safe markdown", async () => {
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

    expect((await screen.findByText("94123")).tagName.toLowerCase()).toBe("code");
    expect(screen.getByRole("list")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByRole("link", { name: /open-meteo/i })).toHaveAttribute(
      "href",
      "https://open-meteo.com/en/docs",
    );
    expect(screen.getByRole("link", { name: /open-meteo/i })).toHaveAttribute("rel", "noreferrer");
    expect(screen.queryByText(/alert/i)).not.toBeInTheDocument();
  });

  it("rewrites local markdown links to the thread file preview endpoint", async () => {
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

    expect(await screen.findByRole("link", { name: "notes" })).toHaveAttribute(
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

  it("rewrites line-suffixed local markdown links and keeps the source location for preview callbacks", async () => {
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

    expect(await screen.findByRole("link", { name: "indexed" })).toHaveAttribute(
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

  it("opens local markdown links through the markdown preview callback on normal click", async () => {
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

    const link = await screen.findByRole("link", { name: "feedback" });
    fireEvent.click(link);

    expect(onMarkdownOpen).toHaveBeenCalledWith({
      fragment: "#notes",
      href: "http://localhost:3000/v1/threads/thread-1/files/preview?path=%2FUsers%2Fexample%2Fkodex%2Ftimeline-rendering-feedback.md#notes",
      path: "/Users/example/kodex/timeline-rendering-feedback.md",
      title: "timeline-rendering-feedback.md",
    });
  });

  it("opens relative uploaded markdown links through the markdown preview callback", async () => {
    const onMarkdownOpen = vi.fn<(request: MarkdownPreviewRequest) => void>();
    render(
      <MantineProvider>
        <TimelineItemRenderer
          onMarkdownOpen={onMarkdownOpen}
          threadId="thread-1"
          item={item({
            kind: "assistant_message",
            text: "Read [uploaded](.kodex/uploads/thread-1/file-1/notes.md).",
          })}
        />
      </MantineProvider>,
    );

    const link = await screen.findByRole("link", { name: "uploaded" });
    expect(link).toHaveAttribute(
      "href",
      "http://localhost:3000/v1/threads/thread-1/files/preview?path=.kodex%2Fuploads%2Fthread-1%2Ffile-1%2Fnotes.md",
    );
    fireEvent.click(link);

    expect(onMarkdownOpen).toHaveBeenCalledWith({
      fragment: "",
      href: "http://localhost:3000/v1/threads/thread-1/files/preview?path=.kodex%2Fuploads%2Fthread-1%2Ffile-1%2Fnotes.md",
      path: ".kodex/uploads/thread-1/file-1/notes.md",
      title: "notes.md",
    });
  });

  it("preserves browser-native modifier-click behavior for local markdown links", async () => {
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

    fireEvent.click(await screen.findByRole("link", { name: "feedback" }), { metaKey: true });

    expect(onMarkdownOpen).not.toHaveBeenCalled();
  });

  it("opens local assistant markdown image links in the image viewer through the thread file preview endpoint", async () => {
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
    const link = await screen.findByRole("link", { name: "03-inline-review-toast.png" });
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

  it("opens inline pdf links through the thread file preview endpoint in a new tab", async () => {
    render(
      <MantineProvider>
        <TimelineItemRenderer
          threadId="thread-1"
          item={item({
            kind: "assistant_message",
            text:
              "Read [report](/Users/example/kodex/report.pdf#page=2) and [uploaded](.kodex/uploads/thread-1/file-1/report.pdf).",
          })}
        />
      </MantineProvider>,
    );

    const report = await screen.findByRole("link", { name: "report" });
    expect(report).toHaveAttribute(
      "href",
      "http://localhost:3000/v1/threads/thread-1/files/preview?path=%2FUsers%2Fexample%2Fkodex%2Freport.pdf#page=2",
    );
    expect(report).toHaveAttribute("target", "_blank");
    expect(report).not.toHaveAttribute("download");

    const uploaded = screen.getByRole("link", { name: "uploaded" });
    expect(uploaded).toHaveAttribute(
      "href",
      "http://localhost:3000/v1/threads/thread-1/files/preview?path=.kodex%2Fuploads%2Fthread-1%2Ffile-1%2Freport.pdf",
    );
    expect(uploaded).toHaveAttribute("target", "_blank");
    expect(uploaded).not.toHaveAttribute("download");
  });

  it("downloads other inline file links through the thread file preview endpoint", async () => {
    render(
      <MantineProvider>
        <TimelineItemRenderer
          threadId="thread-1"
          item={item({
            kind: "assistant_message",
            text:
              "Open [data](/Users/example/kodex/data.csv) and [archive](.kodex/uploads/thread-1/file-1/archive.zip).",
          })}
        />
      </MantineProvider>,
    );

    const data = await screen.findByRole("link", { name: "data" });
    expect(data).toHaveAttribute(
      "href",
      "http://localhost:3000/v1/threads/thread-1/files/preview?path=%2FUsers%2Fexample%2Fkodex%2Fdata.csv",
    );
    expect(data).toHaveAttribute("download", "data.csv");

    const archive = screen.getByRole("link", { name: "archive" });
    expect(archive).toHaveAttribute(
      "href",
      "http://localhost:3000/v1/threads/thread-1/files/preview?path=.kodex%2Fuploads%2Fthread-1%2Ffile-1%2Farchive.zip",
    );
    expect(archive).toHaveAttribute("download", "archive.zip");
  });

  it("keeps assistant markdown output stable for links, code, lists, breaks, and skipped HTML", async () => {
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
    await screen.findByRole("link", { name: "docs" });
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

  it("renders assistant markdown tables in a scrollable themed shell with GFM alignment", async () => {
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

    await screen.findByRole("table");
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

  it("renders unlabeled fenced code blocks as block code", async () => {
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

    await screen.findByText("npm test");
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

    fireEvent.click(await screen.findByRole("button", { name: /copy code/i }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("npm test"));
    expect(screen.getByRole("button", { name: /copied code/i })).toBeInTheDocument();
    expect(screen.getByText("inline").closest("button")).not.toBeInTheDocument();
  });

  it("does not reparse completed assistant markdown on unrelated parent rerenders", async () => {
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
    await waitFor(() => expect(reactMarkdownRenderSpy).toHaveBeenCalledTimes(1));
    reactMarkdownRenderSpy.mockClear();

    rerender(<CompletedHarness tick={1} />);

    expect(screen.getByTestId("tick")).toHaveTextContent("1");
    expect(screen.getByRole("link", { name: "docs" })).toBeInTheDocument();
    expect(reactMarkdownRenderSpy).not.toHaveBeenCalled();
  });

  it("updates streaming assistant markdown when message text changes", async () => {
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
    await waitFor(() => expect(container.querySelector(".kodex-assistant-markdown")).toBeInTheDocument());
    reactMarkdownRenderSpy.mockClear();

    rerender(<StreamingHarness text={"Checking...\nFound source."} />);

    await waitFor(() => expect(container.querySelector(".kodex-assistant-markdown")).toHaveTextContent("Found source."));
    expect(container.querySelector(".kodex-assistant-markdown")).toHaveTextContent("Checking...");
    expect(container.querySelector(".kodex-assistant-markdown")).toHaveTextContent("Found source.");
    expect(container.querySelector(".kodex-assistant-markdown br")).toBeInTheDocument();
    expect(reactMarkdownRenderSpy).toHaveBeenCalledTimes(1);
  });

  it("preserves assistant markdown soft line breaks during streaming", async () => {
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

    await waitFor(() => expect(container.querySelector(".kodex-assistant-markdown br")).toBeInTheDocument());
  });
});
