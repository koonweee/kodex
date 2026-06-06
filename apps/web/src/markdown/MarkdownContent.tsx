import { Box, Code, Table, Text } from "@mantine/core";
import { Check, Copy } from "lucide-react";
import { Children, isValidElement, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, MouseEvent, ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

import { filePreviewUrl } from "../api/client";
import { fileNameFromPath, filePreviewActionForTarget, type FilePreviewAction } from "../files/filePreviewActions";
import type { MarkdownPreviewRequest } from "../files/types";
import type { ImageLightboxImage } from "../images/types";
import { copyTextToClipboard } from "../shared/clipboard";
import { AdaptiveIconButton } from "../ui/AdaptiveIconButton";

const markdownRemarkPlugins = [remarkGfm, remarkBreaks];

export type MarkdownContentProps = {
  className?: string;
  onImageOpen?: (image: ImageLightboxImage) => void;
  onMarkdownOpen?: (request: MarkdownPreviewRequest) => void;
  text: string;
  threadId?: string;
};

export function MarkdownContent({ className, onImageOpen, onMarkdownOpen, text, threadId }: MarkdownContentProps) {
  const components = useMemo(
    () => markdownComponents(threadId, onImageOpen, onMarkdownOpen),
    [onImageOpen, onMarkdownOpen, threadId],
  );

  return (
    <Box className={className}>
      <ReactMarkdown remarkPlugins={markdownRemarkPlugins} skipHtml components={components}>
        {text}
      </ReactMarkdown>
    </Box>
  );
}

function markdownComponents(
  threadId?: string,
  onImageOpen?: (image: ImageLightboxImage) => void,
  onMarkdownOpen?: (request: MarkdownPreviewRequest) => void,
): Components {
  return {
    a: ({ children, href, title }) => {
      const imagePreview = localImagePreviewHref(threadId, href);
      const filePreview = localFilePreviewHref(threadId, href);
      if (imagePreview) {
        return (
          <a
            href={imagePreview.href}
            target="_blank"
            rel="noreferrer"
            onClick={(event) => {
              if (!onImageOpen || shouldUseNativeLinkClick(event)) {
                return;
              }
              event.preventDefault();
              onImageOpen({ alt: "", src: imagePreview.href, title: title ?? imagePreview.path });
            }}
          >
            {children}
          </a>
        );
      }
      const linkHref = filePreviewHref(filePreview) ?? href;
      const download = filePreviewDownload(filePreview, onMarkdownOpen);
      return (
        <a
          href={linkHref}
          target="_blank"
          rel="noreferrer"
          download={download}
          onClick={(event) => {
            if (filePreview?.kind !== "markdown" || !onMarkdownOpen || shouldUseNativeLinkClick(event)) {
              return;
            }
            event.preventDefault();
            onMarkdownOpen({ ...filePreview.request, title: title ?? filePreview.request.title });
          }}
        >
          {children}
        </a>
      );
    },
    code: ({ children, className }) => {
      const isBlock = Boolean(className) || String(children).includes("\n");
      return isBlock ? (
        <MarkdownCodeBlock>{children}</MarkdownCodeBlock>
      ) : (
        <Code className="kodex-assistant-inline-code">{children}</Code>
      );
    },
    p: ({ children }) => (
      <Text component="p" size="sm" className="kodex-assistant-markdown-paragraph">
        {children}
      </Text>
    ),
    pre: ({ children }) => <>{children}</>,
    table: ({ children }) => (
      <Table.ScrollContainer className="kodex-markdown-table-scroll" minWidth="100%" type="native">
        <Table horizontalSpacing="sm" verticalSpacing="xs" withRowBorders>
          {children}
        </Table>
      </Table.ScrollContainer>
    ),
    tbody: ({ children }) => <Table.Tbody>{children}</Table.Tbody>,
    td: ({ align, children, node: _node, style, ...props }) => (
      <Table.Td {...props} style={markdownTableCellStyle(align, style)}>
        {children}
      </Table.Td>
    ),
    tfoot: ({ children }) => <Table.Tfoot>{children}</Table.Tfoot>,
    th: ({ align, children, node: _node, style, ...props }) => (
      <Table.Th {...props} style={markdownTableCellStyle(align, style)}>
        {children}
      </Table.Th>
    ),
    thead: ({ children }) => <Table.Thead>{children}</Table.Thead>,
    tr: ({ children }) => <Table.Tr>{children}</Table.Tr>,
  };
}

function markdownTableCellStyle(
  align: "center" | "char" | "justify" | "left" | "right" | undefined,
  style?: CSSProperties,
): CSSProperties | undefined {
  if (!align || align === "char" || align === "justify") {
    return style;
  }
  return { ...style, textAlign: align };
}

function MarkdownCodeBlock({ children }: { children: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const resetTimerRef = useRef<number | null>(null);
  const copyText = useMemo(() => codeBlockClipboardText(children), [children]);

  useEffect(() => {
    return () => {
      if (resetTimerRef.current !== null) {
        window.clearTimeout(resetTimerRef.current);
      }
    };
  }, []);

  async function handleCopy() {
    const copied = await copyTextToClipboard(copyText);
    if (!copied) {
      return;
    }
    setCopied(true);
    if (resetTimerRef.current !== null) {
      window.clearTimeout(resetTimerRef.current);
    }
    resetTimerRef.current = window.setTimeout(() => {
      setCopied(false);
      resetTimerRef.current = null;
    }, 1_300);
  }

  return (
    <Box className="kodex-code-block-shell">
      <Code block className="kodex-timeline-code">
        {children}
      </Code>
      <AdaptiveIconButton
        className="kodex-code-copy-button"
        density="compact"
        label={copied ? "Copied code" : "Copy code"}
        onClick={handleCopy}
      >
        {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      </AdaptiveIconButton>
    </Box>
  );
}

function codeBlockClipboardText(children: ReactNode): string {
  const text = reactNodeText(children);
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}

function reactNodeText(children: ReactNode): string {
  return Children.toArray(children)
    .map((child) => {
      if (typeof child === "string" || typeof child === "number") {
        return String(child);
      }
      if (isValidElement<{ children?: ReactNode }>(child)) {
        return reactNodeText(child.props.children);
      }
      return "";
    })
    .join("");
}

function localFilePreviewHref(threadId?: string, href?: string): FilePreviewAction | null {
  const target = href ? localFilePreviewActionTarget(href) : null;
  if (!threadId || !target) {
    return null;
  }
  return filePreviewActionForTarget(threadId, target);
}

function localImagePreviewHref(threadId?: string, href?: string): { href: string; path: string } | null {
  const target = href ? localImagePreviewTarget(href) : null;
  if (!threadId || !target) {
    return null;
  }
  return {
    href: filePreviewUrl(threadId, target.path),
    path: target.path,
  };
}

function localFilePreviewActionTarget(href: string): {
  column?: number;
  fileName: string;
  fragment: string;
  line?: number;
  path: string;
  title?: string;
} | null {
  const { fragment, path } = localFilePreviewTarget(href);
  const markdownTarget = localMarkdownPathWithLocation(path);
  if (markdownTarget) {
    const fileName = fileNameFromPath(markdownTarget.path);
    return {
      ...markdownTarget,
      fileName,
      fragment,
      title: markdownLocationTitle(fileName, markdownTarget.line, markdownTarget.column),
    };
  }
  if (!isLocalFilePath(path) || !fileNameHasExtension(path)) {
    return null;
  }
  return {
    fileName: fileNameFromPath(path),
    fragment,
    path,
  };
}

function localImagePreviewTarget(href: string): { path: string } | null {
  const { path } = localFilePreviewTarget(href);
  if (!isLocalImagePath(path)) {
    return null;
  }
  return { path };
}

function localFilePreviewTarget(href: string): { fragment: string; path: string } {
  const hashIndex = href.indexOf("#");
  const pathWithQuery = hashIndex >= 0 ? href.slice(0, hashIndex) : href;
  const fragment = hashIndex >= 0 ? href.slice(hashIndex) : "";
  const queryIndex = pathWithQuery.indexOf("?");
  const path = queryIndex >= 0 ? pathWithQuery.slice(0, queryIndex) : pathWithQuery;
  return { fragment, path };
}

function isLocalMarkdownPath(path: string): boolean {
  return isLocalFilePath(path) && /\.(?:md|markdown)$/i.test(path);
}

function localMarkdownPathWithLocation(path: string): { column?: number; line?: number; path: string } | null {
  if (isLocalMarkdownPath(path)) {
    return { path };
  }
  const match = path.match(/^(.+\.(?:md|markdown)):([1-9]\d*)(?::([1-9]\d*))?$/i);
  if (!match || !isLocalMarkdownPath(match[1])) {
    return null;
  }
  return {
    column: match[3] ? Number(match[3]) : undefined,
    line: Number(match[2]),
    path: match[1],
  };
}

function isLocalImagePath(path: string): boolean {
  return isLocalFilePath(path) && /\.(?:png|jpe?g|gif|webp)$/i.test(path);
}

function isLocalFilePath(path: string): boolean {
  return isLocalAbsolutePath(path) || isSafeRelativeLocalPath(path);
}

function isSafeRelativeLocalPath(path: string): boolean {
  if (!path || path.startsWith("/") || path.startsWith("\\") || path.startsWith("#") || path.startsWith("?")) {
    return false;
  }
  if (path.startsWith("//") || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(path)) {
    return false;
  }
  return path.split(/[\\/]+/).every((part) => part && part !== "." && part !== "..");
}

function isLocalAbsolutePath(path: string): boolean {
  return /^(?:\/(?!\/)|[A-Za-z]:[\\/])/.test(path);
}

function shouldUseNativeLinkClick(event: MouseEvent<HTMLAnchorElement>) {
  return event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0;
}

function markdownFileName(path: string): string {
  return fileNameFromPath(path) || "Markdown preview";
}

function markdownLocationTitle(fileName: string, line?: number, column?: number): string {
  if (!line) {
    return fileName;
  }
  return column ? `${fileName}:${line}:${column}` : `${fileName}:${line}`;
}

function filePreviewHref(filePreview: FilePreviewAction | null): string | undefined {
  if (!filePreview) {
    return undefined;
  }
  return filePreview.kind === "markdown" ? filePreview.request.href : filePreview.href;
}

function filePreviewDownload(
  filePreview: FilePreviewAction | null,
  onMarkdownOpen?: (request: MarkdownPreviewRequest) => void,
): string | undefined {
  if (!filePreview) {
    return undefined;
  }
  if (filePreview.kind === "download") {
    return filePreview.fileName;
  }
  if (filePreview.kind === "markdown" && !onMarkdownOpen) {
    return markdownFileName(filePreview.request.path);
  }
  return undefined;
}

function fileNameHasExtension(path: string): boolean {
  return /\.[A-Za-z0-9]{1,16}$/.test(fileNameFromPath(path));
}
