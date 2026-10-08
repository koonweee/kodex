import { MantineProvider } from "@mantine/core";
import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps, FormEvent, RefObject } from "react";

import { listSkills } from "../api/client";
import { createKodexQueryClient } from "../api/queryClient";
import type { SkillMetadata } from "../api/client";
import type { ComposerSettings } from "../ComposerFooterControls";
import { INTERFACE_PREFERENCES_STORAGE_KEY, readStoredInterfacePreferences } from "../preferences/useInterfacePreferences";
import { ComposerPanel } from "./ComposerPanel";

vi.mock("../api/client", async (importActual) => ({
  ...(await importActual<typeof import("../api/client")>()),
  listSkills: vi.fn(),
}));

const paneLayout = vi.hoisted(() => ({ compact: true, short: false }));
vi.mock("../shared/PaneLayout", () => ({ usePaneLayout: () => paneLayout }));

const composerSettings: ComposerSettings = {
  effort: "high",
  fast: false,
  model: "gpt-5.5",
};

function noopSubmit(event: FormEvent) {
  event.preventDefault();
}

describe("Mobile composer panel", () => {
  beforeEach(() => {
    window.localStorage.clear();
    readStoredInterfacePreferences(true);
    vi.mocked(listSkills).mockReset();
    setMobileViewport(true);
    paneLayout.compact = true;
    vi.stubGlobal("PointerEvent", class extends MouseEvent {
      pointerType: string;
      constructor(type: string, options: PointerEventInit = {}) {
        super(type, options);
        this.pointerType = options.pointerType ?? "";
      }
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    window.localStorage.clear();
    readStoredInterfacePreferences(true);
  });

  it("renders the shared inline composer with compact density without an existing-thread underbar", async () => {
    renderComposerPanel({
      contextUsage: { contextTokens: 24_000, modelContextWindow: 120_000 },
    });

    expect(document.querySelector(".kodex-composer-shell")).toHaveAttribute("data-inline-density", "compact");
    expect(screen.getByLabelText(/message composer/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /permissions:/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /model: gpt-5\.5, high/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /expand composer/i })).not.toBeInTheDocument();
    expect(screen.getByRole("img", { name: /context/i })).toBeInTheDocument();
    expect(screen.queryByRole("toolbar", { name: /composer context|draft thread toolbar/i })).not.toBeInTheDocument();
  });

  it("collapses an empty existing composer only after editing focus leaves, without replacing its input", async () => {
    setMobileViewport(true, { touch: false });
    renderComposerPanel();
    const input = screen.getByLabelText(/message composer/i);
    const form = input.closest("form")!;
    expect(form).toHaveAttribute("data-idle-compact", "true");
    await userEvent.click(input);
    expect(form).toHaveAttribute("data-idle-compact", "false");
    await userEvent.type(input, "Keep draft");
    await userEvent.click(document.body);
    expect(form).toHaveAttribute("data-idle-compact", "false");
    await userEvent.clear(input);
    expect(form).toHaveAttribute("data-idle-compact", "false");
    await userEvent.click(screen.getByRole("button", { name: /model: gpt-5\.5, high/i }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Reasoning" }));
    expect(form).toHaveAttribute("data-idle-compact", "false");
    await userEvent.keyboard("{Escape}");
    await userEvent.click(document.body);
    await waitFor(() => expect(form).toHaveAttribute("data-idle-compact", "true"));
    expect(screen.getByLabelText(/message composer/i)).toBe(input);
  });

  it("keeps footer interactions compact until the editable field is activated, including Stop", async () => {
    const onStopTurn = vi.fn();
    renderComposerPanel({ activeSelectedTurnId: "running", onStopTurn });
    const form = screen.getByLabelText(/message composer/i).closest("form")!;
    expect(form).toHaveAttribute("data-idle-compact", "true");
    await userEvent.click(screen.getByRole("button", { name: /open attachment menu/i }));
    expect(await screen.findByRole("menuitem", { name: /add attachment/i })).toBeInTheDocument();
    expect(form).toHaveAttribute("data-idle-compact", "true");
    await userEvent.keyboard("{Escape}");
    await userEvent.click(screen.getByRole("button", { name: /stop turn/i }));
    expect(onStopTurn).toHaveBeenCalledOnce();
    expect(form).toHaveAttribute("data-idle-compact", "true");
  });

  it.each([
    { name: "timeline attachment", props: { isSelectedTimelineReady: false } },
    { name: "thread settings read", props: { composerSettings: null } },
    { name: "settings update", props: { composerSettingsDisabled: true } },
    { name: "attachment and settings", props: { isSelectedTimelineReady: false, composerSettings: null, composerSettingsDisabled: true } },
  ])("keeps an empty compact composer idle through $name", ({ props: loading }) => {
    const props: Partial<ComponentProps<typeof ComposerPanel>> = { ...loading };
    const view = renderComposerPanel(props);
    const input = screen.getByLabelText(/message composer/i);
    const form = input.closest("form")!;
    expect(form).toHaveAttribute("data-idle-compact", "true");
    if (props.isSelectedTimelineReady === false) {
      expect(screen.getByRole("button", { name: /open attachment menu/i })).toBeDisabled();
    }
    if (props.composerSettingsDisabled || props.composerSettings === null) {
      expect(screen.getByRole("button", { name: /model:|loading chat settings/i })).toBeDisabled();
    }
    Object.assign(props, { isSelectedTimelineReady: true, composerSettings, composerSettingsDisabled: false });
    view.refreshLayout();
    expect(form).toHaveAttribute("data-idle-compact", "true");
    expect(screen.getByLabelText(/message composer/i)).toBe(input);
    expect(screen.getByRole("button", { name: /open attachment menu/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /model:/i })).toBeEnabled();
  });

  it("preserves a restored draft while its compact pane is loading", () => {
    const props: Partial<ComponentProps<typeof ComposerPanel>> = {
      isSelectedTimelineReady: false,
      composerSettings: null,
      composerSettingsDisabled: true,
      composerDraftStore: new Map([["__default__", { composerText: "Keep my draft", skillBindings: [] }]]),
    };
    const view = renderComposerPanel(props);
    const input = screen.getByLabelText(/message composer/i);
    expect(input).toHaveValue("Keep my draft");
    expect(input.closest("form")).toHaveAttribute("data-idle-compact", "false");
    Object.assign(props, { isSelectedTimelineReady: true, composerSettings, composerSettingsDisabled: false });
    view.refreshLayout();
    expect(screen.getByLabelText(/message composer/i)).toBe(input);
    expect(input).toHaveValue("Keep my draft");
    expect(input.closest("form")).toHaveAttribute("data-idle-compact", "false");
  });

  it("keeps an active empty editor open during settings and timeline loading", async () => {
    setMobileViewport(true, { touch: false });
    const props: Partial<ComponentProps<typeof ComposerPanel>> = {};
    const view = renderComposerPanel(props);
    const input = screen.getByLabelText(/message composer/i);
    await userEvent.click(input);
    Object.assign(props, { isSelectedTimelineReady: false, composerSettingsDisabled: true });
    view.refreshLayout();
    expect(input.closest("form")).toHaveAttribute("data-idle-compact", "false");
    expect(screen.getByLabelText(/message composer/i)).toBe(input);
    expect(input).toHaveFocus();
  });

  it.each([
    { name: "settings errors", props: { composerSettingsError: "Could not load settings" } },
    { name: "submission", props: { isComposerSubmitting: true } },
    { name: "new conversations", props: { isDraftThreadSelected: true, selectedThreadPresent: false } },
    { name: "attachments", props: { pendingAttachments: [{ id: "file", file: new File(["draft"], "draft.txt"), kind: "file" as const, status: "pending" as const }] } },
    { name: "whitespace drafts", props: { composerDraftStore: new Map([["__default__", { composerText: " \n", skillBindings: [] }]]) } },
    { name: "annotations", props: { composerDraftStore: new Map([["__default__", { composerText: "", skillBindings: [], annotations: [{ id: "note", text: "Selection", comment: "Explain" }] }]]) } },
  ])("keeps $name at the normal composer height", ({ props }) => {
    renderComposerPanel(props);
    expect(screen.getByLabelText(/message composer/i).closest("form")).toHaveAttribute("data-idle-compact", "false");
  });

  it("uses normal height in a regular pane and preserves an active empty input across width changes", async () => {
    setMobileViewport(false, { touch: false });
    paneLayout.compact = false;
    const view = renderComposerPanel();
    const input = screen.getByLabelText(/message composer/i);
    const form = input.closest("form")!;
    expect(form).toHaveAttribute("data-idle-compact", "false");
    await userEvent.click(input);
    paneLayout.compact = true;
    view.refreshLayout();
    expect(form).toHaveAttribute("data-idle-compact", "false");
    expect(screen.getByLabelText(/message composer/i)).toBe(input);
    expect(input).toHaveFocus();
  });

  it("opens fullscreen composer when its editable field receives touch", async () => {
    renderComposerPanel();

    const textarea = screen.getByLabelText(/message composer/i);
    await openByTouch(textarea);

    expect(screen.getByRole("dialog", { name: /compose/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/message composer/i)).toBe(textarea);
    expect(textarea).toHaveFocus();
  });

  it("shows the idle composer in a regular touch pane and opens fullscreen at wide viewport", async () => {
    setMobileViewport(false);
    paneLayout.compact = false;
    renderComposerPanel();
    const textarea = screen.getByLabelText(/message composer/i);
    expect(textarea.closest("form")).toHaveAttribute("data-idle-compact", "true");

    await openByTouch(textarea);

    expect(screen.getByRole("dialog", { name: /compose/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/message composer/i)).toBe(textarea);
    expect(textarea).toHaveFocus();
  });

  it("keeps touch activation inline when fullscreen opening is disabled for this device", async () => {
    window.localStorage.setItem(INTERFACE_PREFERENCES_STORAGE_KEY, JSON.stringify({ fullscreenComposerOnTouch: false }));
    setMobileViewport(false);
    paneLayout.compact = false;
    renderComposerPanel();
    const textarea = screen.getByLabelText(/message composer/i);
    expect(textarea.closest("form")).toHaveAttribute("data-idle-compact", "true");

    await openByTouch(textarea);

    expect(screen.queryByRole("dialog", { name: /compose/i })).not.toBeInTheDocument();
    expect(textarea.closest("form")).toHaveAttribute("data-idle-compact", "false");
    expect(textarea).toHaveFocus();
  });

  it("keeps the narrow non-touch composer inline when the textarea is focused", async () => {
    setMobileViewport(true, { touch: false });
    renderComposerPanel();

    await userEvent.click(screen.getByLabelText(/message composer/i));

    expect(document.querySelector(".kodex-composer-shell")).toHaveAttribute("data-inline-density", "compact");
    expect(screen.queryByRole("dialog", { name: /compose/i })).not.toBeInTheDocument();
    expect(screen.getByLabelText(/message composer/i)).toHaveFocus();
  });

  it("keeps mouse and programmatic focus inline on a touch-capable workspace, then expands on touch of the focused field", async () => {
    renderComposerPanel();
    const textarea = screen.getByLabelText(/message composer/i);
    await userEvent.click(textarea);
    expect(textarea).toHaveFocus();
    expect(screen.queryByRole("dialog", { name: /compose/i })).not.toBeInTheDocument();
    fireEvent.focus(textarea);
    expect(screen.queryByRole("dialog", { name: /compose/i })).not.toBeInTheDocument();
    fireEvent.pointerDown(textarea, { pointerType: "touch" });
    expect(screen.getByRole("dialog", { name: /compose/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/message composer/i)).toBe(textarea);
    expect(textarea).toHaveFocus();
  });

  it("keeps the input, draft and selection when touch expands from a wide workspace", async () => {
    setMobileViewport(false);
    const view = renderComposerPanel();
    const input = screen.getByLabelText(/message composer/i) as HTMLTextAreaElement;
    await userEvent.type(input, "Keep composing");
    input.setSelectionRange(2, 6);
    fireEvent.compositionStart(input);
    paneLayout.compact = false;
    view.refreshLayout();
    expect(screen.getByLabelText(/message composer/i)).toBe(input);
    expect(input).toHaveFocus();
    expect(input).toHaveValue("Keep composing");
    expect([input.selectionStart, input.selectionEnd]).toEqual([2, 6]);
    paneLayout.compact = true;
    view.refreshLayout();
    fireEvent.compositionEnd(input);
    fireEvent.pointerDown(input, { pointerType: "touch" });
    expect(screen.getByRole("dialog", { name: /compose/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/message composer/i)).toBe(input);
    expect(input).toHaveFocus();
    expect([input.selectionStart, input.selectionEnd]).toEqual([2, 6]);
  });

  it("anchors fullscreen composer to the visual viewport when mobile browser chrome shifts", async () => {
    vi.stubGlobal("innerHeight", 800);
    vi.stubGlobal("visualViewport", {
      addEventListener: () => undefined,
      height: 520,
      offsetTop: 24,
      removeEventListener: () => undefined,
    });
    renderComposerPanel();

    await openByTouch(screen.getByLabelText(/message composer/i));

    const dialog = screen.getByRole("dialog", { name: /compose/i });
    expect(dialog).toHaveStyle({
      "--kodex-mobile-keyboard-inset": "256px",
      "--kodex-mobile-visual-viewport-height": "520px",
      "--kodex-mobile-pane-viewport-offset-top": "24px",
    });

  });

  it("preserves draft text when collapsing back to inline mode", async () => {
    renderComposerPanel();

    await openByTouch(screen.getByLabelText(/message composer/i));
    expect(screen.getByRole("dialog", { name: /compose/i })).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText(/message composer/i), "Long mobile draft");
    expect(screen.getByLabelText(/message composer/i)).toHaveValue("Long mobile draft");

    await userEvent.click(screen.getByRole("button", { name: /collapse composer/i }));

    expect(document.querySelector(".kodex-composer-shell")).toHaveAttribute("data-inline-density", "compact");
    expect(screen.getByLabelText(/message composer/i)).toHaveValue("Long mobile draft");
  });

  it("preserves the selected draft position when reopening fullscreen from touch", async () => {
    renderComposerPanel();

    await openByTouch(screen.getByLabelText(/message composer/i));
    await userEvent.type(screen.getByLabelText(/message composer/i), "Long mobile draft");
    await userEvent.click(screen.getByRole("button", { name: /collapse composer/i }));

    const inlineTextarea = screen.getByLabelText(/message composer/i) as HTMLTextAreaElement;
    inlineTextarea.setSelectionRange(3, 7);
    fireEvent.pointerDown(inlineTextarea, { pointerType: "touch" });

    const expandedTextarea = screen.getByLabelText(/message composer/i) as HTMLTextAreaElement;
    await waitFor(() => {
      expect(expandedTextarea.selectionStart).toBe(3);
      expect(expandedTextarea.selectionEnd).toBe(7);
    });
  });

  it("returns from expanded composer to inline mode on collapse", async () => {
    renderComposerPanel();

    await openByTouch(screen.getByLabelText(/message composer/i));
    expect(screen.getByRole("dialog", { name: /compose/i })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /collapse composer/i }));
    await waitFor(() =>
      expect(document.querySelector(".kodex-composer-shell")).toHaveAttribute("data-inline-density", "compact"),
    );

    await openByTouch(screen.getByLabelText(/message composer/i));
    expect(await screen.findByRole("dialog", { name: /compose/i })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /collapse composer/i }));

    await waitFor(() => expect(screen.queryByRole("dialog", { name: /compose/i })).not.toBeInTheDocument());
    expect(document.querySelector(".kodex-composer-shell")).toHaveAttribute("data-inline-density", "compact");
  });

  it("closes expanded composer after submit and preserves the shared submit controls", async () => {
    const submittedDrafts: string[] = [];
    renderComposerPanel({
      onSubmitTurn: (event, draftText, controls) => {
        event.preventDefault();
        submittedDrafts.push(draftText);
        controls.clearText();
      },
    });

    await openByTouch(screen.getByLabelText(/message composer/i));
    expect(screen.getByRole("dialog", { name: /compose/i })).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/message composer/i), "Send from expanded");
    await userEvent.click(screen.getByRole("button", { name: /send message/i }));

    await waitFor(() => expect(submittedDrafts).toEqual(["Send from expanded"]));
    expect(document.querySelector(".kodex-composer-shell")).toHaveAttribute("data-inline-density", "compact");
    expect(screen.getByLabelText(/message composer/i)).toHaveValue("");
  });

  it("keeps attachment previews compact in inline and fullscreen mobile modes", async () => {
    renderComposerPanel({
      pendingAttachments: [
        {
          file: new File(["image"], "preview.png", { type: "image/png" }),
          id: "attachment-1",
          kind: "image",
          objectUrl: "blob:kodex-preview",
          status: "pending",
        },
      ],
    });

    expect(screen.getByRole("button", { name: /remove preview\.png/i })).toBeInTheDocument();
    expect(document.querySelector(".kodex-attachment-tray")).toHaveAttribute("data-compact", "true");

    await openByTouch(screen.getByLabelText(/message composer/i));

    expect(screen.getByRole("dialog", { name: /compose/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /remove preview\.png/i })).toBeInTheDocument();
    expect(document.querySelector(".kodex-attachment-tray")).toHaveAttribute("data-compact", "true");
  });

  it("uses the shared toolbar in fullscreen and forwards settings changes", async () => {
    const onComposerSettingsChange = vi.fn();
    renderComposerPanel({ onComposerSettingsChange });

    await openByTouch(screen.getByLabelText(/message composer/i));
    expect(screen.getByRole("dialog", { name: /compose/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /open attachment menu/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /permissions:/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /model: gpt-5\.5, high/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /send message/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /settings/i })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /model: gpt-5\.5, high/i }));
    await userEvent.click(await screen.findByText("Fast"));

    expect(onComposerSettingsChange).toHaveBeenCalledWith({
      fast: true,
      serviceTier: "fast",
    });
  });

  it("uses the mobile skill command sheet for $ suggestions", async () => {
    mockSkills([
      skillFixture({
        description: "Generate raster images",
        interface: {
          brandColor: "#8B5CF6",
          displayName: "Image Gen",
          iconSmall: "/skills/imagegen/icon.png",
          shortDescription: "Generate images",
        },
        name: "imagegen",
      }),
    ]);
    renderComposerPanel();

    await openByTouch(screen.getByLabelText(/message composer/i));
    await userEvent.type(screen.getByLabelText(/message composer/i), "$img");

    expect(await screen.findByRole("listbox", { name: /skill suggestions/i })).toBeInTheDocument();
    const option = screen.getByRole("option", { name: /image gen/i });
    const optionIcon = option.querySelector(".kodex-skill-option-icon") as HTMLElement;
    expect(optionIcon).toHaveAttribute("data-has-accent", "true");
    expect(optionIcon.style.getPropertyValue("--skill-brand-color")).toBe("#8B5CF6");
    expect(optionIcon.querySelector("img")).toHaveAttribute(
      "src",
      "http://localhost:3000/v1/skills/icon?path=%2Fskills%2Fimagegen%2Ficon.png",
    );
    expect(document.querySelector(".kodex-skill-popup")).not.toBeInTheDocument();
    expect(screen.queryByText("Generate raster images")).not.toBeInTheDocument();
    expect(document.querySelector(".kodex-mobile-skill-command-description")).not.toBeInTheDocument();

    await userEvent.click(option);

    await waitFor(() => expect(screen.getByLabelText(/message composer/i)).toHaveValue("$imagegen "));
  });

  it("uses the mobile command sheet for slash command suggestions", async () => {
    renderComposerPanel();

    await openByTouch(screen.getByLabelText(/message composer/i));
    await userEvent.type(screen.getByLabelText(/message composer/i), "/co");

    expect(await screen.findByRole("listbox", { name: /slash command suggestions/i })).toBeInTheDocument();
    const option = screen.getByRole("option", { name: /compact/i });
    expect(option).toHaveTextContent("/compact");
    expect(document.querySelector(".kodex-skill-popup")).not.toBeInTheDocument();

    await userEvent.click(option);

    await waitFor(() => expect(screen.getByLabelText(/message composer/i)).toHaveValue("/compact "));
  });

  it("renders generated first-character icons for mobile skill suggestions without icon assets", async () => {
    mockSkills([
      skillFixture({
        interface: { brandColor: "#0F9D58", displayName: "Google Drive" },
        name: "google-drive:google-drive",
      }),
    ]);
    renderComposerPanel();

    await openByTouch(screen.getByLabelText(/message composer/i));
    await userEvent.type(screen.getByLabelText(/message composer/i), "$drive");

    const option = await screen.findByRole("option", { name: /google drive/i });
    const optionIcon = option.querySelector(".kodex-skill-option-icon") as HTMLElement;
    expect(optionIcon).toHaveAttribute("data-has-accent", "true");
    expect(optionIcon.style.getPropertyValue("--skill-brand-color")).toBe("#0F9D58");
    expect(optionIcon.querySelector("img")).not.toBeInTheDocument();
    expect(optionIcon).toHaveTextContent("G");
  });

  it("renders svg mobile skill suggestion icons as themed masks", async () => {
    mockSkills([
      skillFixture({
        interface: {
          brandColor: "#4285F4",
          displayName: "Google Drive",
          iconSmall: "/skills/google-drive/google-drive-small.svg",
        },
        name: "google-drive:google-drive",
      }),
    ]);
    renderComposerPanel();

    await openByTouch(screen.getByLabelText(/message composer/i));
    await userEvent.type(screen.getByLabelText(/message composer/i), "$drive");

    const option = await screen.findByRole("option", { name: /google drive/i });
    const optionIcon = option.querySelector(".kodex-skill-option-icon") as HTMLElement;
    const svgIcon = optionIcon.querySelector(".kodex-skill-option-icon-svg") as HTMLElement;
    expect(optionIcon).toHaveAttribute("data-has-accent", "true");
    expect(optionIcon.style.getPropertyValue("--skill-brand-color")).toBe("#4285F4");
    expect(optionIcon.querySelector("img")).not.toBeInTheDocument();
    expect(svgIcon).toBeInTheDocument();
    expect(svgIcon.style.getPropertyValue("--skill-icon-mask")).toContain("google-drive-small.svg");
  });

  it("reserves readable fullscreen space for the mobile skill command sheet", async () => {
    mockSkills([
      skillFixture({
        description: "Generate raster images",
        interface: { displayName: "Image Gen", shortDescription: "Generate images" },
        name: "imagegen",
      }),
    ]);
    renderComposerPanel();

    await openByTouch(screen.getByLabelText(/message composer/i));
    expect(screen.getByRole("dialog", { name: /compose/i })).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/message composer/i), "$img");
    expect(await screen.findByRole("listbox", { name: /skill suggestions/i })).toBeInTheDocument();

    expect(screen.getByRole("dialog", { name: /compose/i })).toBeInTheDocument();
    expect(document.querySelector(".kodex-mobile-composer-expanded-body")).toHaveAttribute(
      "data-skill-command-open",
      "true",
    );
    expect(screen.getByRole("listbox", { name: /skill suggestions/i })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /image gen/i }).tagName).toBe("BUTTON");
    expect(screen.queryByRole("button", { name: /send message/i })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("option", { name: /image gen/i }));
    await waitFor(() => expect(screen.getByLabelText(/message composer/i)).toHaveValue("$imagegen "));
    expect(screen.getByRole("button", { name: /send message/i })).toBeInTheDocument();
  });
});

function renderComposerPanel(props: Partial<ComponentProps<typeof ComposerPanel>> = {}) {
  const attachmentInputRef = { current: null } as RefObject<HTMLInputElement | null>;
  const queryClient = createKodexQueryClient();
  const node = () => (
    <QueryClientProvider client={queryClient}>
      <MantineProvider>
        <ComposerPanel
          activeSelectedTurnId={null}
          attachmentInputRef={attachmentInputRef}
          canCompose
          composerCwd="/workspace"
          composerResetToken={0}
          composerSettings={composerSettings}
          composerSettingsError={null}
          contextUsage={null}
          isDraftThreadSelected={false}
          isDraftComposerTransitioning={false}
          isComposerDragActive={false}
          isComposerSubmitting={false}
          isSelectedTimelineReady
          models={[
            {
              id: "gpt-5.5",
              model: "gpt-5.5",
              displayName: "GPT-5.5",
              description: "Coding model",
              defaultReasoningEffort: "high",
              hidden: false,
              inputModalities: ["text"],
              isDefault: true,
              rawPayload: {},
              supportedReasoningEfforts: [{ reasoningEffort: "high", description: "Deep reasoning" }],
              upgrade: null,
            },
          ]}
          onAttachmentInputChange={vi.fn()}
          onComposerDragLeave={vi.fn()}
          onComposerDragOver={vi.fn()}
          onComposerDrop={vi.fn()}
          onComposerKeyDown={vi.fn()}
          onComposerPaste={vi.fn()}
          onComposerSettingsChange={vi.fn()}
          onImageOpen={vi.fn()}
          onRemovePendingAttachment={vi.fn()}
          onStopTurn={vi.fn()}
          onSubmitTurn={noopSubmit}
          pendingAttachments={[]}
          selectedThreadPresent
          {...props}
        />
      </MantineProvider>
    </QueryClientProvider>
  );
  const view = render(node());
  return { ...view, refreshLayout: () => view.rerender(node()) };
}

async function openByTouch(textarea: HTMLElement) {
  // JSDOM focus comes from the ensuing click; the event initiating expansion is touch.
  fireEvent.pointerDown(textarea, { pointerType: "touch" });
  await userEvent.click(textarea);
}

function mockSkills(skills: SkillMetadata[]) {
  vi.mocked(listSkills).mockResolvedValue({
    cwd: "/workspace",
    errors: [],
    invalidationGeneration: 0,
    skills,
  });
}

function skillFixture(overrides: Partial<SkillMetadata> = {}): SkillMetadata {
  const name = overrides.name ?? "imagegen";
  return {
    description: `${name} description`,
    enabled: true,
    interface: null,
    name,
    path: `/skills/${name}/SKILL.md`,
    scope: "user",
    ...overrides,
  };
}

function setMobileViewport(matches: boolean, options: { touch?: boolean } = {}) {
  const isTouchDevice = options.touch ?? true;
  vi.stubGlobal("matchMedia", (query: string): MediaQueryList => ({
    matches:
      query === "(max-width: 900px)"
        ? matches
        : query === "(any-pointer: coarse)" || query === "(pointer: coarse)"
          ? isTouchDevice
          : false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
}
