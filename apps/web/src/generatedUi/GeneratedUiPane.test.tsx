import { readFileSync } from "node:fs";
import { join } from "node:path";

import { MantineProvider } from "@mantine/core";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";

import type { GeneratedUiSession } from "../api/client";
import { GeneratedUiPane } from "./GeneratedUiPane";

const generatedUiCss = readFileSync(join(process.cwd(), "src/styles/generated-ui.css"), "utf8");
type GeneratedUiPaneSubmit = ComponentProps<typeof GeneratedUiPane>["onSubmit"];

describe("GeneratedUiPane", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("submits a concise visible message and optional metadata from iframe postMessage", async () => {
    const session = generatedUiSession({ revision: 3 });
    const onSubmit = vi.fn().mockResolvedValue({
      input: { disposition: "started", queuedInput: null, rawPayload: { turnId: "turn-1" } },
      session: { ...session, status: "submitted", submitAvailable: false, submittedRevision: 3 },
    }) as unknown as GeneratedUiPaneSubmit;

    renderPane(session, { onSubmit });
    const iframe = screen.getByTitle(/generated ui:/i) as HTMLIFrameElement;
    const postMessage = vi.fn();
    Object.defineProperty(iframe.contentWindow, "postMessage", {
      configurable: true,
      value: postMessage,
    });

    postFromFrame({
      type: "kodex.ui.submit",
      requestId: "submit-request-1",
      sessionId: "session-1",
      revision: 3,
      message: "  Choose the compact layout  ",
      metadata: { selected: "compact" },
    });

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({
        revision: 3,
        message: "Choose the compact layout",
        metadata: { selected: "compact" },
      });
      expect(postMessage).toHaveBeenCalledWith(
        {
          type: "kodex.generatedUi.submit.result",
          requestId: "submit-request-1",
          ok: true,
          status: "submitted",
          result: { disposition: "started", queuedInput: null, rawPayload: { turnId: "turn-1" } },
        },
        "*",
      );
    });
  });

  it("reports unrecognized kodex postMessage event types back to the iframe", async () => {
    const onSubmit = vi.fn() as unknown as GeneratedUiPaneSubmit;
    renderPane(generatedUiSession({ revision: 3 }), { onSubmit });
    const iframe = screen.getByTitle(/generated ui:/i) as HTMLIFrameElement;
    const postMessage = vi.fn();
    Object.defineProperty(iframe.contentWindow, "postMessage", {
      configurable: true,
      value: postMessage,
    });

    postFromFrame({
      type: "kodex:submit-message",
      requestId: "wrong-submit-1",
      message: "Hi",
    });

    expect(onSubmit).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith(
      {
        type: "kodex.generatedUi.submit.result",
        requestId: "wrong-submit-1",
        ok: false,
        status: "ignored",
        error: {
          code: "unrecognized_event_type",
          message: "Unrecognized generated UI event type: kodex:submit-message",
        },
      },
      "*",
    );
  });

  it("loads the generated document into a themed iframe srcDoc", async () => {
    renderPane(generatedUiSession(), {
      colorSchemeId: "paper-light",
      documentHtml: "<!doctype html><html><head><title>Mockups</title></head><body><button>Pick</button></body></html>",
    });

    const iframe = screen.getByTitle(/generated ui:/i) as HTMLIFrameElement;
    await waitFor(() => {
      expect(iframe).toHaveAttribute("srcdoc", expect.stringContaining("kodex-generated-ui-theme"));
    });
    expect(iframe).not.toHaveAttribute("src");
    expect(iframe.getAttribute("srcdoc")).toContain("--kodex-bg-app: #ece6db;");
    expect(iframe.getAttribute("srcdoc")).toContain("<button>Pick</button>");
  });

  it("ignores submit messages for a different session or revision", async () => {
    const onSubmit = vi.fn() as unknown as GeneratedUiPaneSubmit;
    renderPane(generatedUiSession({ revision: 3 }), { onSubmit });

    postFromFrame({
      type: "kodex.ui.submit",
      sessionId: "other-session",
      revision: 3,
      message: "Wrong session",
    });
    postFromFrame({
      type: "kodex.ui.submit",
      sessionId: "session-1",
      revision: 2,
      message: "Wrong revision",
    });

    await waitFor(() => expect(onSubmit).not.toHaveBeenCalled());
  });

  it("ignores duplicate submit messages for a submitted revision", async () => {
    const onSubmit = vi.fn() as unknown as GeneratedUiPaneSubmit;
    renderPane(generatedUiSession({ status: "submitted", submitAvailable: false }), { onSubmit });

    postFromFrame({
      type: "kodex.generatedUi.submit",
      message: "Submit again",
    });

    expect(onSubmit).not.toHaveBeenCalled();
    expect(await screen.findByRole("alert")).toHaveTextContent(/already been submitted/i);
  });

  it("hides through the mobile pane header control", async () => {
    vi.spyOn(window, "matchMedia").mockImplementation((query: string): MediaQueryList => ({
      addEventListener: vi.fn(),
      addListener: vi.fn(),
      dispatchEvent: vi.fn(),
      matches: query === "(max-width: 900px)",
      media: query,
      onchange: null,
      removeEventListener: vi.fn(),
      removeListener: vi.fn(),
    }));
    const onHide = vi.fn();
    renderPane(generatedUiSession(), { onHide });

    await userEvent.click(screen.getByRole("button", { name: /hide generated ui/i }));

    expect(onHide).toHaveBeenCalledTimes(1);
  });

  it("keeps the narrow generated UI surface as a full-page bottom sheet", () => {
    expect(generatedUiCss).toMatch(/@media \(max-width:\s*900px\)/);
    expect(generatedUiCss).toMatch(/\.kodex-generated-ui-surface\s*\{[^}]*position:\s*fixed;[^}]*inset:\s*0;/s);
    expect(generatedUiCss).toMatch(/@keyframes kodex-generated-ui-sheet-in\s*\{[^}]*from\s*\{[^}]*translateY\(100%\)/s);
  });

  it("does not force a white iframe border or background around dark generated UIs", () => {
    expect(generatedUiCss).toMatch(/\.kodex-generated-ui-frame-wrap\s*\{[^}]*background:\s*transparent;/s);
    expect(generatedUiCss).not.toMatch(/\.kodex-generated-ui-frame-wrap\s*\{[^}]*border:\s*1px solid/s);
    expect(generatedUiCss).toMatch(/\.kodex-generated-ui-frame\s*\{[^}]*background:\s*transparent;/s);
  });
});

function renderPane(
  session: GeneratedUiSession,
  overrides: {
    colorSchemeId?: ComponentProps<typeof GeneratedUiPane>["colorSchemeId"];
    documentHtml?: string;
    onHide?: () => void;
    onSubmit?: GeneratedUiPaneSubmit;
  } = {},
) {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(overrides.documentHtml ?? "<main>Generated UI</main>", {
      headers: { "Content-Type": "text/html" },
    }),
  );
  const defaultSubmit: GeneratedUiPaneSubmit = async () => ({
    input: { disposition: "started", queuedInput: null, rawPayload: {} },
    session,
  });
  return render(
    <MantineProvider>
      <GeneratedUiPane
        colorSchemeId={overrides.colorSchemeId ?? "oled-black"}
        isSubmitting={false}
        onHide={overrides.onHide ?? vi.fn()}
        onSubmit={overrides.onSubmit ?? defaultSubmit}
        session={session}
      />
    </MantineProvider>,
  );
}

function postFromFrame(data: unknown) {
  const iframe = screen.getByTitle(/generated ui:/i) as HTMLIFrameElement;
  const event = new MessageEvent("message", { data });
  Object.defineProperty(event, "source", { value: iframe.contentWindow });
  window.dispatchEvent(event);
}

function generatedUiSession(overrides: Partial<GeneratedUiSession> = {}): GeneratedUiSession {
  return {
    archivedAt: null,
    createdAt: "2026-04-30T00:00:00Z",
    documentUrl: "/v1/generated-ui/sessions/session-1/document?revision=1",
    id: "session-1",
    networkPolicy: "self_contained",
    revision: 1,
    status: "interactive",
    submitAvailable: true,
    submittedAt: null,
    submittedMessage: null,
    submittedMetadata: null,
    submittedRevision: null,
    threadId: "thread-1",
    title: "Mockups",
    updatedAt: "2026-04-30T00:00:00Z",
    ...overrides,
  };
}
