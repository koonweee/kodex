import { Box, Code, Table, Text } from "@mantine/core";
import { Check, Copy } from "lucide-react";
import { Children, isValidElement, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, MouseEvent, ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

import { filePreviewUrl } from "../api/client";
import type { MarkdownPreviewRequest } from "../files/types";
import type { ImageLightboxImage } from "../images/types";
import { copyTextToClipboard } from "../shared/clipboard";

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
      const markdownPreview = localMarkdownPreviewHref(threadId, href);
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
      return (
        <a
          href={markdownPreview?.href ?? href}
          target="_blank"
          rel="noreferrer"
          download={onMarkdownOpen ? undefined : markdownPreview?.download}
          onClick={(event) => {
            if (!markdownPreview || !onMarkdownOpen || shouldUseNativeLinkClick(event)) {
              return;
            }
            event.preventDefault();
            onMarkdownOpen({
              fragment: markdownPreview.fragment,
              href: markdownPreview.href,
              column: markdownPreview.column,
              line: markdownPreview.line,
              path: markdownPreview.path,
              title: title ?? markdownPreview.title,
            });
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
      <button
        aria-label={copied ? "Copied code" : "Copy code"}
        className="kodex-ui-button kodex-ui-icon-button kodex-code-copy-button"
        onClick={handleCopy}
        title={copied ? "Copied code" : "Copy code"}
        type="button"
      >
        {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
      </button>
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

function localMarkdownPreviewHref(
  threadId?: string,
  href?: string,
): {
  column?: number;
  download: string;
  fragment: string;
  href: string;
  line?: number;
  path: string;
  title: string;
} | null {
  const target = href ? localMarkdownPreviewTarget(href) : null;
  if (!threadId || !target) {
    return null;
  }
  const download = markdownFileName(target.path);
  return {
    column: target.column,
    download,
    fragment: target.fragment,
    href: `${filePreviewUrl(threadId, target.path)}${target.fragment}`,
    line: target.line,
    path: target.path,
    title: markdownLocationTitle(download, target.line, target.column),
  };
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

function localMarkdownPreviewTarget(href: string): { column?: number; fragment: string; line?: number; path: string } | null {
  const { fragment, path } = localFilePreviewTarget(href);
  const target = localMarkdownPathWithLocation(path);
  if (!target) {
    return null;
  }
  return { ...target, fragment };
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
  return isLocalAbsolutePath(path) && /\.(?:md|markdown)$/i.test(path);
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
  return isLocalAbsolutePath(path) && /\.(?:png|jpe?g|gif|webp)$/i.test(path);
}

function isLocalAbsolutePath(path: string): boolean {
  return /^(?:\/(?!\/)|[A-Za-z]:[\\/])/.test(path);
}

function shouldUseNativeLinkClick(event: MouseEvent<HTMLAnchorElement>) {
  return event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0;
}

function markdownFileName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || "Markdown preview";
}

function markdownLocationTitle(fileName: string, line?: number, column?: number): string {
  if (!line) {
    return fileName;
  }
  return column ? `${fileName}:${line}:${column}` : `${fileName}:${line}`;
}
