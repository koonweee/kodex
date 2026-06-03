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

describe("timeline image renderers", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    reactMarkdownRenderSpy.mockClear();
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
});
