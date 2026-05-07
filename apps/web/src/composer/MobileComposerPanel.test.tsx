import { readFileSync } from "node:fs";
import { join } from "node:path";

import { MantineProvider } from "@mantine/core";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps, FormEvent, RefObject } from "react";

import { listSkills } from "../api/client";
import type { SkillMetadata } from "../api/client";
import type { ComposerSettings } from "../ComposerFooterControls";
import { ComposerPanel } from "./ComposerPanel";

const mobileComposerCss = readFileSync(join(process.cwd(), "src/styles/mobile-composer.css"), "utf8");

vi.mock("../api/client", async (importActual) => ({
  ...(await importActual<typeof import("../api/client")>()),
  listSkills: vi.fn(),
}));

const composerSettings: ComposerSettings = {
  effort: "high",
  fast: false,
  model: "gpt-5.5",
  permissionPreset: "autoReview",
};

function noopSubmit(event: FormEvent) {
  event.preventDefault();
}

describe("Mobile composer panel", () => {
  beforeEach(() => {
    vi.mocked(listSkills).mockReset();
    setMobileViewport(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the shared inline composer with mobile density and the same underbar", () => {
    renderComposerPanel({
      contextUsage: { contextTokens: 24_000, modelContextWindow: 120_000 },
      selectedGitBranch: "main",
    });

    expect(document.querySelector(".kodex-composer-shell")).toHaveAttribute("data-inline-density", "mobile");
    expect(screen.getByLabelText(/message composer/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /permissions: auto review/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /model: gpt-5\.5, high/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /expand composer/i })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /context/i })).toBeInTheDocument();
    expect(screen.getByRole("toolbar", { name: /composer context/i })).toHaveClass("kodex-composer-underbar");
    expect(screen.getByText("main")).toBeInTheDocument();
    expect(mobileComposerCss).not.toMatch(/\.kodex-composer-shell\[data-inline-density="mobile"\] \.kodex-composer-underbar\s*\{/);
  });

  it("keeps non-fullscreen mobile composer to one inline state after focus", async () => {
    renderComposerPanel();

    await userEvent.click(screen.getByLabelText(/message composer/i));

    expect(document.querySelector(".kodex-composer-shell")).toHaveAttribute("data-inline-density", "mobile");
    expect(screen.queryByRole("form", { name: /mobile focused composer/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: /compose/i })).not.toBeInTheDocument();
  });

  it("opens fullscreen composer from the shared inline composer", async () => {
    renderComposerPanel();

    await userEvent.click(screen.getByLabelText(/message composer/i));

    await userEvent.type(screen.getByLabelText(/message composer/i), "Long mobile draft");
    expect(screen.getByLabelText(/message composer/i)).toHaveValue("Long mobile draft");

    await userEvent.click(screen.getByRole("button", { name: /expand composer/i }));

    expect(screen.getByRole("dialog", { name: /compose/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/message composer/i)).toHaveValue("Long mobile draft");

    await userEvent.click(screen.getByRole("button", { name: /collapse composer/i }));

    expect(document.querySelector(".kodex-composer-shell")).toHaveAttribute("data-inline-density", "mobile");
    expect(screen.getByLabelText(/message composer/i)).toHaveValue("Long mobile draft");
  });

  it("returns from expanded composer to inline mode on collapse", async () => {
    renderComposerPanel();

    await userEvent.click(screen.getByRole("button", { name: /expand composer/i }));
    expect(screen.getByRole("dialog", { name: /compose/i })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /collapse composer/i }));
    expect(document.querySelector(".kodex-composer-shell")).toHaveAttribute("data-inline-density", "mobile");

    await userEvent.click(screen.getByLabelText(/message composer/i));
    await userEvent.click(screen.getByRole("button", { name: /expand composer/i }));
    await userEvent.click(screen.getByRole("button", { name: /collapse composer/i }));

    expect(document.querySelector(".kodex-composer-shell")).toHaveAttribute("data-inline-density", "mobile");
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

    await userEvent.click(screen.getByLabelText(/message composer/i));
    await userEvent.type(screen.getByLabelText(/message composer/i), "Send from expanded");
    await userEvent.click(screen.getByRole("button", { name: /expand composer/i }));
    await userEvent.click(screen.getByRole("button", { name: /send message/i }));

    await waitFor(() => expect(submittedDrafts).toEqual(["Send from expanded"]));
    expect(document.querySelector(".kodex-composer-shell")).toHaveAttribute("data-inline-density", "mobile");
    expect(screen.getByLabelText(/message composer/i)).toHaveValue("");
  });

  it("keeps attachment previews compact in inline and fullscreen mobile modes", async () => {
    renderComposerPanel({
      pendingAttachments: [
        {
          file: new File(["image"], "preview.png", { type: "image/png" }),
          id: "attachment-1",
          objectUrl: "blob:kodex-preview",
          status: "pending",
        },
      ],
    });

    await userEvent.click(screen.getByLabelText(/message composer/i));
    expect(screen.getByRole("button", { name: /remove preview\.png/i })).toBeInTheDocument();
    expect(document.querySelector(".kodex-attachment-tray")).toHaveAttribute("data-compact", "false");

    await userEvent.click(screen.getByRole("button", { name: /expand composer/i }));

    expect(screen.getByRole("dialog", { name: /compose/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /remove preview\.png/i })).toBeInTheDocument();
    expect(document.querySelector(".kodex-attachment-tray")).toHaveAttribute("data-compact", "true");
  });

  it("uses the shared toolbar in fullscreen and forwards settings changes", async () => {
    const onComposerSettingsChange = vi.fn();
    renderComposerPanel({ onComposerSettingsChange });

    await userEvent.click(screen.getByRole("button", { name: /expand composer/i }));
    expect(screen.getByRole("dialog", { name: /compose/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /open attachment menu/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /permissions: auto review/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /model: gpt-5\.5, high/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /send message/i })).toHaveClass("kodex-composer-action");
    expect(screen.queryByRole("button", { name: /settings/i })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /model: gpt-5\.5, high/i }));
    await userEvent.click(await screen.findByText("Fast"));

    expect(onComposerSettingsChange).toHaveBeenCalledWith({
      ...composerSettings,
      fast: true,
    });
  });

  it("uses the mobile skill command sheet for $ suggestions", async () => {
    mockSkills([
      skillFixture({
        description: "Generate raster images",
        interface: { displayName: "Image Gen", shortDescription: "Generate images" },
        name: "imagegen",
      }),
    ]);
    renderComposerPanel();

    await userEvent.click(screen.getByLabelText(/message composer/i));
    await userEvent.type(screen.getByLabelText(/message composer/i), "$img");

    expect(await screen.findByRole("listbox", { name: /skill suggestions/i })).toHaveClass(
      "kodex-mobile-skill-command-list",
    );
    expect(document.querySelector(".kodex-skill-popup")).not.toBeInTheDocument();
    expect(screen.queryByText("Generate raster images")).not.toBeInTheDocument();
    expect(document.querySelector(".kodex-mobile-skill-command-description")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("option", { name: /image gen/i }));

    await waitFor(() => expect(screen.getByLabelText(/message composer/i)).toHaveValue("$imagegen "));
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

    await userEvent.click(screen.getByLabelText(/message composer/i));
    await userEvent.type(screen.getByLabelText(/message composer/i), "$img");
    expect(await screen.findByRole("listbox", { name: /skill suggestions/i })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /expand composer/i }));

    expect(screen.getByRole("dialog", { name: /compose/i })).toBeInTheDocument();
    expect(document.querySelector(".kodex-mobile-composer-expanded-body")).toHaveAttribute(
      "data-skill-command-open",
      "true",
    );
    expect(document.querySelector(".kodex-mobile-composer-expanded-main")).toHaveAttribute(
      "data-skill-command-open",
      "true",
    );
    expect(screen.getByRole("listbox", { name: /skill suggestions/i })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /image gen/i }).tagName).toBe("BUTTON");
    expect(screen.queryByRole("button", { name: /send message/i })).not.toBeInTheDocument();
    expect(mobileComposerCss).toMatch(
      /\.kodex-mobile-composer-expanded-body\s*\{[^}]*grid-template-rows:\s*minmax\(0,\s*1fr\)\s*auto;/s,
    );
    expect(mobileComposerCss).toMatch(
      /\.kodex-mobile-composer-expanded-body\[data-skill-command-open="true"\]\s*\{[^}]*grid-template-rows:\s*minmax\(0,\s*1fr\);/s,
    );
    expect(mobileComposerCss).toMatch(
      /\.kodex-mobile-composer-expanded \.kodex-mobile-skill-command-list\s*\{[^}]*min-height:\s*clamp\(160px,\s*30dvh,\s*240px\);/s,
    );
    expect(mobileComposerCss).toMatch(
      /\.kodex-mobile-composer-expanded-main\[data-skill-command-open="true"\]\s*\{[^}]*padding-bottom:\s*12px;/s,
    );
    expect(mobileComposerCss).toMatch(
      /\.kodex-mobile-composer-expanded \.kodex-mobile-skill-command-list\s*\{[^}]*scroll-padding-block:\s*12px;/s,
    );
    expect(mobileComposerCss).toMatch(
      /\.kodex-mobile-composer-expanded-footer\s*\{[^}]*z-index:\s*1;/s,
    );
    expect(mobileComposerCss).toMatch(
      /\.kodex-mobile-composer-expanded \.kodex-mobile-skill-command-list\s*\{[^}]*z-index:\s*3;/s,
    );
    expect(mobileComposerCss).toMatch(
      /\.kodex-mobile-composer-expanded-main\[data-skill-command-open="true"\] \.kodex-mobile-composer-textarea textarea\s*\{[^}]*max-height:\s*clamp\(120px,\s*28dvh,\s*220px\);/s,
    );

    await userEvent.click(screen.getByRole("option", { name: /image gen/i }));
    await waitFor(() => expect(screen.getByLabelText(/message composer/i)).toHaveValue("$imagegen "));
    expect(screen.getByRole("button", { name: /send message/i })).toBeInTheDocument();
  });
});

function renderComposerPanel(props: Partial<ComponentProps<typeof ComposerPanel>> = {}) {
  const attachmentInputRef = { current: null } as RefObject<HTMLInputElement | null>;
  return render(
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
        onAbortQueuedSteer={vi.fn()}
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
        onSubmitQueuedSteer={vi.fn()}
        onSubmitTurn={noopSubmit}
        pendingAttachments={[]}
        queuedSteerRows={[]}
        selectedThreadPresent
        {...props}
      />
    </MantineProvider>,
  );
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

function setMobileViewport(matches: boolean) {
  vi.stubGlobal("matchMedia", (query: string): MediaQueryList => ({
    matches: query === "(max-width: 900px)" ? matches : false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
}
