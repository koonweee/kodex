import { MantineProvider } from "@mantine/core";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TimelineItemRenderer } from "../timeline/renderers";
import { MarkdownContent } from "../markdown/MarkdownContent";

describe("local HTML and video links", () => {
  it.each(["index.html", "index.htm", "clip.webm", "clip.mp4"])("opens existing %s links in a new tab without downloading", (name) => {
    render(<MantineProvider><MarkdownContent threadId="thread-1" text={`[Open](artifacts/gallery/${name})`} /></MantineProvider>);
    const link = screen.getByRole("link", { name: "Open" });
    expect(link.getAttribute("href")).toContain(`/v1/threads/thread-1/files/preview?path=artifacts%2Fgallery%2F${name}`);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noreferrer");
    expect(link).not.toHaveAttribute("download");
  });
  it.each(["index.html", "clip.webm", "clip.mp4"])("opens attached %s files in a new tab", (name) => {
    render(<MantineProvider><TimelineItemRenderer threadId="thread-1" item={{
      id: "item-1", kind: "user_message", status: "completed", text: "Inspect this",
      turnId: "turn-1", displayOrder: 1, payload: {}, debugEvents: [],
      fileAttachments: [{ id: "file-1", fileName: name, extension: name.split(".").at(-1)!, relativePath: `artifacts/gallery/${name}`, sizeBytes: 42 }],
    }} /></MantineProvider>);
    const link = screen.getByRole("link", { name: `Open ${name}` });
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noreferrer");
    expect(link).not.toHaveAttribute("download");
  });
});
