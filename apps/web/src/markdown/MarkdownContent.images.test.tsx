import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { MarkdownContent } from "./MarkdownContent";

function markdown(text: string, threadId?: string) {
  render(<MantineProvider><MarkdownContent text={text} threadId={threadId} /></MantineProvider>);
}

describe("Markdown image previews", () => {
  it("loads absolute and relative local images through the thread preview endpoint", () => {
    markdown("![Gallery](/Users/example/kodex/artifacts/gallery.png)\n\n![Upload](.kodex/uploads/thread-1/image.webp)", "thread/with spaces");
    expect(screen.getByRole("img", { name: "Gallery" })).toHaveAttribute("src",
      "http://localhost:3000/v1/threads/thread%2Fwith%20spaces/files/preview?path=%2FUsers%2Fexample%2Fkodex%2Fartifacts%2Fgallery.png");
    expect(screen.getByRole("img", { name: "Upload" })).toHaveAttribute("src",
      "http://localhost:3000/v1/threads/thread%2Fwith%20spaces/files/preview?path=.kodex%2Fuploads%2Fthread-1%2Fimage.webp");
  });

  it("decodes Markdown image paths with spaces before requesting the local file", () => {
    markdown('![Gallery](</Users/example/kodex/card gallery.png> "Card gallery")', "thread-1");
    expect(screen.getByRole("img", { name: "Gallery" })).toHaveAttribute("src",
      "http://localhost:3000/v1/threads/thread-1/files/preview?path=%2FUsers%2Fexample%2Fkodex%2Fcard%20gallery.png");
    expect(screen.getByRole("img", { name: "Gallery" })).toHaveAttribute("title", "Card gallery");
  });

  it.each([
    ["/tmp/what%23next.png", "%2Ftmp%2Fwhat%23next.png"],
    ["/tmp/rate%growth.png", "%2Ftmp%2Frate%25growth.png"],
  ])("previews filenames with reserved or literal percent characters: %s", (source, encodedPath) => {
    markdown(`![Image](${source})`, "thread-1");
    expect(screen.getByRole("img", { name: "Image" })).toHaveAttribute("src",
      `http://localhost:3000/v1/threads/thread-1/files/preview?path=${encodedPath}`);
  });

  it("keeps normalized image links opening the existing image viewer", () => {
    const onImageOpen = vi.fn();
    render(<MantineProvider><MarkdownContent text="[Gallery](</tmp/card gallery.png>)"
      threadId="thread-1" onImageOpen={onImageOpen} /></MantineProvider>);
    fireEvent.click(screen.getByRole("link", { name: "Gallery" }));
    expect(onImageOpen).toHaveBeenCalledWith({ alt: "", title: "/tmp/card gallery.png",
      src: "http://localhost:3000/v1/threads/thread-1/files/preview?path=%2Ftmp%2Fcard%20gallery.png" });
  });

  it("preserves remote images and existing preview URLs", () => {
    markdown("![Remote](https://example.com/image.png)\n\n![Protocol relative](//example.com/image.png)\n\n![Existing](/v1/threads/thread-1/files/preview?path=%2Ftmp%2Fimage.png)", "thread-1");
    expect(screen.getByRole("img", { name: "Remote" })).toHaveAttribute("src", "https://example.com/image.png");
    expect(screen.getByRole("img", { name: "Protocol relative" })).toHaveAttribute("src", "//example.com/image.png");
    expect(screen.getByRole("img", { name: "Existing" })).toHaveAttribute("src", "/v1/threads/thread-1/files/preview?path=%2Ftmp%2Fimage.png");
  });

  it("preserves local sources when no thread preview context exists", () => {
    markdown("![Local](/tmp/image.png)");
    expect(screen.getByRole("img", { name: "Local" })).toHaveAttribute("src", "/tmp/image.png");
  });
});
