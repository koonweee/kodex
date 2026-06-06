import { MantineProvider } from "@mantine/core";
import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useRef, useState, type ComponentProps, type FormEvent, type ReactElement, type ReactNode, type RefObject } from "react";

import { listSkills } from "../api/client";
import { createKodexQueryClient } from "../api/queryClient";
import type { SkillMetadata } from "../api/client";
import type { ComposerSettings } from "../ComposerFooterControls";
import { ComposerPanel, type ComposerDraftControls } from "./ComposerPanel";

vi.mock("../api/client", async (importActual) => ({
  ...(await importActual<typeof import("../api/client")>()),
  listSkills: vi.fn(),
}));

const composerSettings: ComposerSettings = {
  effort: "medium",
  fast: false,
  model: "gpt-5.4",
};

function noopSubmit(event: FormEvent) {
  event.preventDefault();
}

function skillFixture(overrides: Partial<SkillMetadata> = {}): SkillMetadata {
  const name = overrides.name ?? "review-fix";
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

function mockSkills(skills: SkillMetadata[]) {
  vi.mocked(listSkills).mockResolvedValue({
    cwd: "/workspace",
    errors: [],
    invalidationGeneration: 0,
    skills,
  });
}

function queryWrapper() {
  const queryClient = createKodexQueryClient();
  return function TestQueryProvider({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

function renderWithQueryProvider(ui: ReactElement) {
  return render(ui, { wrapper: queryWrapper() });
}

function renderComposerPanel(
  props: Partial<ComponentProps<typeof ComposerPanel>> = {},
) {
  const attachmentInputRef = { current: null } as RefObject<HTMLInputElement | null>;
  return renderWithQueryProvider(
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
        models={[]}
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

describe("ComposerPanel", () => {
  beforeEach(() => {
    vi.mocked(listSkills).mockReset();
  });

  it("opens skill autocomplete from $ and submits selected skill inputs", async () => {
    mockSkills([
      skillFixture({
        description: "Review and fix changes",
        interface: {
          brandColor: "#23a55a",
          displayName: "Review Fix",
          iconSmall: "/skills/review-fix/icon.png",
          shortDescription: "Review loop",
        },
        name: "review-fix",
        path: "/skills/review-fix/SKILL.md",
      }),
    ]);
    const submittedSkillInputs: unknown[][] = [];
    const submittedSkillTextElements: unknown[][] = [];
    const submittedSkillMentions: unknown[][] = [];

    renderComposerPanel({
      onSubmitTurn: (event, _draft, controls, skillInputs, skillTextElements, skillMentions) => {
        event.preventDefault();
        submittedSkillInputs.push(skillInputs);
        submittedSkillTextElements.push(skillTextElements);
        submittedSkillMentions.push(skillMentions);
        controls.clearText();
      },
    });

    const composer = screen.getByLabelText(/message composer/i);
    await userEvent.type(composer, "$rev");
    const option = await screen.findByRole("option", { name: /review fix/i });
    expect(option).toBeInTheDocument();
    const optionIcon = option.querySelector(".kodex-skill-option-icon") as HTMLElement;
    expect(optionIcon).toHaveAttribute("data-has-accent", "true");
    expect(optionIcon.style.getPropertyValue("--skill-brand-color")).toBe("#23a55a");
    expect(optionIcon.querySelector("img")).toHaveAttribute(
      "src",
      "http://localhost:3000/v1/skills/icon?path=%2Fskills%2Freview-fix%2Ficon.png",
    );
    await userEvent.keyboard("{Enter}");
    expect(composer).toHaveValue("$review-fix ");
    await userEvent.click(screen.getByRole("button", { name: /send message/i }));

    await waitFor(() =>
      expect(submittedSkillInputs).toEqual([
        [{ type: "skill", name: "review-fix", path: "/skills/review-fix/SKILL.md" }],
      ]),
    );
    expect(submittedSkillTextElements).toEqual([
      [
        {
          byteRange: { start: 0, end: "$review-fix".length },
          placeholder: "$review-fix",
        },
      ],
    ]);
    expect(submittedSkillMentions).toEqual([
      [
        {
          start: 0,
          end: "$review-fix".length,
          name: "review-fix",
          path: "/skills/review-fix/SKILL.md",
          displayName: "Review Fix",
          scope: "user",
          shortDescription: "Review loop",
          brandColor: "#23a55a",
          iconSmallUrl: "http://localhost:3000/v1/skills/icon?path=%2Fskills%2Freview-fix%2Ficon.png",
        },
      ],
    ]);
  });

  it("renders skill autocomplete suggestions", async () => {
    mockSkills([skillFixture({ interface: { displayName: "Review Fix" }, name: "review-fix" })]);
    renderComposerPanel({ isDraftThreadSelected: true, selectedThreadPresent: false });

    await userEvent.type(screen.getByLabelText(/message composer/i), "$rev");

    expect(await screen.findByRole("listbox", { name: /skill suggestions/i })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /review fix/i })).toBeInTheDocument();
  });

  it("renders a generated first-character icon for skill suggestions without icon assets", async () => {
    mockSkills([
      skillFixture({
        interface: { brandColor: "#F9AB00", displayName: "Google Slides" },
        name: "google-drive:google-slides",
      }),
    ]);
    renderComposerPanel({ isDraftThreadSelected: true, selectedThreadPresent: false });

    await userEvent.type(screen.getByLabelText(/message composer/i), "$slides");

    const option = await screen.findByRole("option", { name: /google slides/i });
    const optionIcon = option.querySelector(".kodex-skill-option-icon") as HTMLElement;
    expect(optionIcon).toHaveAttribute("data-has-accent", "true");
    expect(optionIcon.style.getPropertyValue("--skill-brand-color")).toBe("#F9AB00");
    expect(optionIcon.querySelector("img")).not.toBeInTheDocument();
    expect(optionIcon).toHaveTextContent("G");
  });

  it("renders svg skill suggestion icons as themed masks", async () => {
    mockSkills([
      skillFixture({
        interface: {
          brandColor: "#24292f",
          displayName: "GitHub",
          iconSmall: "/skills/github/github-small.svg",
        },
        name: "github:github",
      }),
    ]);
    renderComposerPanel({ isDraftThreadSelected: true, selectedThreadPresent: false });

    await userEvent.type(screen.getByLabelText(/message composer/i), "$git");

    const option = await screen.findByRole("option", { name: /github/i });
    const optionIcon = option.querySelector(".kodex-skill-option-icon") as HTMLElement;
    const svgIcon = optionIcon.querySelector(".kodex-skill-option-icon-svg") as HTMLElement;
    expect(optionIcon).toHaveAttribute("data-has-accent", "true");
    expect(optionIcon.style.getPropertyValue("--skill-brand-color")).toBe("#24292f");
    expect(optionIcon.querySelector("img")).not.toBeInTheDocument();
    expect(svgIcon).toBeInTheDocument();
    expect(svgIcon.style.getPropertyValue("--skill-icon-mask")).toContain("github-small.svg");
  });

  it("layers queued steer rows under the rounded composer surface", () => {
    renderComposerPanel({
      activeSelectedTurnId: "turn-1",
      queuedSteerRows: [
        {
          id: "queue-1",
          threadId: "thread-1",
          input: [{ type: "text", text: "Match the composer" }],
          options: {},
          status: "queued",
          priority: "normal",
          attemptCount: 0,
          lastError: null,
          createdAt: "2026-05-05T00:00:00Z",
          updatedAt: "2026-05-05T00:00:00Z",
        },
      ],
    });

    expect(screen.getByRole("region", { name: /queued steer messages/i })).toHaveClass("kodex-queued-steer");
    expect(screen.getByLabelText(/message composer/i).closest(".kodex-composer")).toBeInTheDocument();
  });

  it("moves skill autocomplete selection with arrow keys", async () => {
    mockSkills([
      skillFixture({ interface: { displayName: "Alpha Skill" }, name: "alpha-skill" }),
      skillFixture({ interface: { displayName: "Beta Skill" }, name: "beta-skill" }),
    ]);
    renderComposerPanel();

    const composer = screen.getByLabelText(/message composer/i);
    await userEvent.type(composer, "$");
    const alpha = await screen.findByRole("option", { name: /alpha skill/i });
    const beta = screen.getByRole("option", { name: /beta skill/i });
    expect(alpha).toHaveAttribute("aria-selected", "true");

    await userEvent.keyboard("{ArrowDown}");
    expect(beta).toHaveAttribute("aria-selected", "true");
    await userEvent.keyboard("{Enter}");
    expect(composer).toHaveValue("$beta-skill ");
  });

  it("scrolls the active skill autocomplete option into view during keyboard navigation", async () => {
    mockSkills(
      Array.from({ length: 10 }, (_, index) =>
        skillFixture({
          interface: { displayName: `Skill ${index}` },
          name: `skill-${index}`,
        }),
      ),
    );

    renderComposerPanel();

    const composer = screen.getByLabelText(/message composer/i);
    await userEvent.type(composer, "$");
    expect(await screen.findByRole("option", { name: /skill 0/i })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    const scrollArea = document.querySelector(".kodex-skill-popup-scroll") as HTMLElement;
    Object.defineProperty(scrollArea, "clientHeight", { configurable: true, value: 40 });
    screen.getAllByRole("option").forEach((option, index) => {
      Object.defineProperty(option, "offsetTop", { configurable: true, value: index * 20 });
      Object.defineProperty(option, "offsetHeight", { configurable: true, value: 20 });
    });

    await userEvent.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}");

    expect(screen.getByRole("option", { name: /skill 3/i })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(scrollArea.scrollTop).toBe(40);
  });

  it("wraps skill autocomplete selection with ArrowUp", async () => {
    mockSkills([
      skillFixture({ interface: { displayName: "Alpha Skill" }, name: "alpha-skill" }),
      skillFixture({ interface: { displayName: "Beta Skill" }, name: "beta-skill" }),
    ]);
    renderComposerPanel();

    const composer = screen.getByLabelText(/message composer/i);
    await userEvent.type(composer, "$");
    expect(await screen.findByRole("option", { name: /alpha skill/i })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    await userEvent.keyboard("{ArrowUp}");
    expect(screen.getByRole("option", { name: /beta skill/i })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await userEvent.keyboard("{Enter}");
    expect(composer).toHaveValue("$beta-skill ");
  });

  it("opens slash command suggestions and inserts the selected command", async () => {
    renderComposerPanel();

    const composer = screen.getByLabelText(/message composer/i);
    await userEvent.type(composer, "/co");
    const compact = await screen.findByRole("option", { name: /compact/i });

    expect(screen.getByRole("listbox", { name: /slash command suggestions/i })).toBeInTheDocument();
    expect(compact).toHaveAttribute("aria-selected", "true");

    await userEvent.keyboard("{Enter}");

    expect(composer).toHaveValue("/compact ");
    expect(screen.queryByRole("listbox", { name: /slash command suggestions/i })).not.toBeInTheDocument();
  });

  it("closes slash command suggestions with Escape without changing draft text", async () => {
    renderComposerPanel();

    const composer = screen.getByLabelText(/message composer/i);
    await userEvent.type(composer, "/co");
    expect(await screen.findByRole("option", { name: /compact/i })).toBeInTheDocument();

    await userEvent.keyboard("{Escape}");

    expect(screen.queryByRole("listbox", { name: /slash command suggestions/i })).not.toBeInTheDocument();
    expect(composer).toHaveValue("/co");
  });

  it("closes skill autocomplete with Escape without changing draft text", async () => {
    mockSkills([skillFixture({ interface: { displayName: "Review Fix" }, name: "review-fix" })]);
    renderComposerPanel();

    const composer = screen.getByLabelText(/message composer/i);
    await userEvent.type(composer, "$rev");
    expect(await screen.findByRole("option", { name: /review fix/i })).toBeInTheDocument();

    await userEvent.keyboard("{Escape}");

    expect(screen.queryByRole("listbox", { name: /skill suggestions/i })).not.toBeInTheDocument();
    expect(composer).toHaveValue("$rev");
  });

  it("selects skill autocomplete rows with click input", async () => {
    mockSkills([skillFixture({ interface: { displayName: "Review Fix" }, name: "review-fix" })]);
    renderComposerPanel();

    const composer = screen.getByLabelText(/message composer/i);
    await userEvent.type(composer, "$rev");
    const option = await screen.findByRole("option", { name: /review fix/i });

    await userEvent.click(option);

    expect(composer).toHaveValue("$review-fix ");
    expect(screen.queryByRole("listbox", { name: /skill suggestions/i })).not.toBeInTheDocument();
    await waitFor(() => expect(composer).toHaveFocus());
  });

  it("deletes an inserted skill token with one Backspace", async () => {
    mockSkills([skillFixture({ interface: { displayName: "Review Fix" }, name: "review-fix" })]);
    const submittedSkillInputs: unknown[][] = [];
    renderComposerPanel({
      onSubmitTurn: (event, _draft, controls, skillInputs) => {
        event.preventDefault();
        submittedSkillInputs.push(skillInputs);
        controls.clearText();
      },
    });

    const composer = screen.getByLabelText(/message composer/i) as HTMLTextAreaElement;
    await userEvent.type(composer, "$rev");
    expect(await screen.findByRole("option", { name: /review fix/i })).toBeInTheDocument();
    await userEvent.keyboard("{Enter}");
    expect(composer).toHaveValue("$review-fix ");

    composer.setSelectionRange(composer.value.length, composer.value.length);
    fireEvent.keyDown(composer, { key: "Backspace" });

    expect(composer).toHaveValue("");

    await userEvent.type(composer, "plain text");
    await userEvent.click(screen.getByRole("button", { name: /send message/i }));
    await waitFor(() => expect(submittedSkillInputs).toEqual([[]]));
  });

  it("closes skill autocomplete on outside pointer input without changing draft text", async () => {
    mockSkills([skillFixture({ interface: { displayName: "Review Fix" }, name: "review-fix" })]);
    renderComposerPanel();

    const composer = screen.getByLabelText(/message composer/i);
    await userEvent.type(composer, "$rev");
    expect(await screen.findByRole("option", { name: /review fix/i })).toBeInTheDocument();

    fireEvent.pointerDown(document.body);

    expect(screen.queryByRole("listbox", { name: /skill suggestions/i })).not.toBeInTheDocument();
    expect(composer).toHaveValue("$rev");
  });

  it("shows an empty skill autocomplete state when no skills match", async () => {
    mockSkills([skillFixture({ interface: { displayName: "Review Fix" }, name: "review-fix" })]);
    renderComposerPanel();

    await userEvent.type(screen.getByLabelText(/message composer/i), "$zzz");

    expect(await screen.findByText("No matching skills")).toBeInTheDocument();
    expect(screen.getByRole("listbox", { name: /skill suggestions/i })).toBeInTheDocument();
  });

  it("keeps draft typing local until submit", async () => {
    const submittedDrafts: string[] = [];
    let parentRenderCount = 0;

    function Harness() {
      parentRenderCount += 1;
      const attachmentInputRef = useRef<HTMLInputElement | null>(null);
      const [submitCount, setSubmitCount] = useState(0);

      function handleSubmit(
        event: FormEvent,
        draftText: string,
        controls: ComposerDraftControls,
      ) {
        event.preventDefault();
        submittedDrafts.push(draftText);
        setSubmitCount((current) => current + 1);
        controls.clearText();
      }

      return (
        <MantineProvider>
          <div data-testid="submit-count">{submitCount}</div>
          <ComposerPanel
            activeSelectedTurnId={null}
            attachmentInputRef={attachmentInputRef}
            canCompose
            composerResetToken={0}
            composerSettings={composerSettings}
            composerSettingsError={null}
            contextUsage={null}
            isDraftThreadSelected={false}
            isDraftComposerTransitioning={false}
            isComposerDragActive={false}
            isComposerSubmitting={false}
            isSelectedTimelineReady
            models={[]}
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
            onSubmitTurn={handleSubmit}
            pendingAttachments={[]}
            queuedSteerRows={[]}
            selectedThreadPresent
          />
        </MantineProvider>
      );
    }

    renderWithQueryProvider(<Harness />);

    const composer = screen.getByLabelText(/message composer/i);
    await userEvent.type(composer, "Keep this local");

    expect(parentRenderCount).toBe(1);
    expect(screen.getByRole("button", { name: /send message/i })).toBeEnabled();
    expect(submittedDrafts).toEqual([]);

    await userEvent.click(screen.getByRole("button", { name: /send message/i }));

    expect(submittedDrafts).toEqual(["Keep this local"]);
    expect(screen.getByTestId("submit-count")).toHaveTextContent("1");
    expect(composer).toHaveValue("");
  });

  it("shows a sending state on the composer action while submit is awaiting ack", () => {
    renderComposerPanel({
      activeSelectedTurnId: "turn-1",
      isComposerSubmitting: true,
    });

    const sendingButton = screen.getByRole("button", { name: /sending message/i });
    expect(sendingButton).toBeDisabled();
    expect(sendingButton).toHaveAttribute("data-action-state", "submitting");
    expect(sendingButton.querySelector(".mantine-Loader-root")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /stop turn/i })).not.toBeInTheDocument();
  });

  it("resets the local draft when the shell asks it to clear", async () => {
    const attachmentInputRef = { current: null } as RefObject<HTMLInputElement | null>;
    const { rerender } = renderWithQueryProvider(
      <MantineProvider>
        <ComposerPanel
          activeSelectedTurnId={null}
          attachmentInputRef={attachmentInputRef}
          canCompose
          composerResetToken={0}
          composerSettings={composerSettings}
          composerSettingsError={null}
          contextUsage={null}
          isDraftThreadSelected={false}
          isDraftComposerTransitioning={false}
          isComposerDragActive={false}
          isComposerSubmitting={false}
          isSelectedTimelineReady
          models={[]}
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
        />
      </MantineProvider>,
    );

    await userEvent.type(screen.getByLabelText(/message composer/i), "Draft");
    expect(screen.getByLabelText(/message composer/i)).toHaveValue("Draft");

    rerender(
      <MantineProvider>
        <ComposerPanel
          activeSelectedTurnId={null}
          attachmentInputRef={attachmentInputRef}
          canCompose
          composerResetToken={1}
          composerSettings={composerSettings}
          composerSettingsError={null}
          contextUsage={null}
          isDraftThreadSelected={false}
          isDraftComposerTransitioning={false}
          isComposerDragActive={false}
          isComposerSubmitting={false}
          isSelectedTimelineReady
          models={[]}
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
        />
      </MantineProvider>,
    );

    expect(screen.getByLabelText(/message composer/i)).toHaveValue("");
  });

  it("hides context usage while the draft composer is selected", () => {
    const attachmentInputRef = { current: null } as RefObject<HTMLInputElement | null>;

    renderWithQueryProvider(
      <MantineProvider>
        <ComposerPanel
          activeSelectedTurnId={null}
          attachmentInputRef={attachmentInputRef}
          canCompose
          composerResetToken={0}
          composerSettings={composerSettings}
          composerSettingsError={null}
          contextUsage={{ contextTokens: 42_000, modelContextWindow: 200_000 }}
          isDraftThreadSelected
          isDraftComposerTransitioning={false}
          isComposerDragActive={false}
          isComposerSubmitting={false}
          isSelectedTimelineReady
          models={[]}
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
          selectedThreadPresent={false}
        />
      </MantineProvider>,
    );

    expect(screen.queryByLabelText(/context/i)).not.toBeInTheDocument();
  });

  it("shows the selected thread git branch in the composer underflow", () => {
    const attachmentInputRef = { current: null } as RefObject<HTMLInputElement | null>;

    renderWithQueryProvider(
      <MantineProvider>
        <ComposerPanel
          activeSelectedTurnId={null}
          attachmentInputRef={attachmentInputRef}
          canCompose
          composerResetToken={0}
          composerSettings={composerSettings}
          composerSettingsError={null}
          contextUsage={null}
          isDraftThreadSelected={false}
          isDraftComposerTransitioning={false}
          isComposerDragActive={false}
          isComposerSubmitting={false}
          isSelectedTimelineReady
          models={[]}
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
          selectedGitBranch="feature/very-long-branch-name-that-should-truncate"
          selectedThreadPresent
        />
      </MantineProvider>,
    );

    expect(screen.getByLabelText("Composer context")).toBeInTheDocument();
    const branch = screen.getByText("feature/very-long-branch-name-that-should-truncate");
    expect(branch).toHaveAttribute("title", "feature/very-long-branch-name-that-should-truncate");
    expect(document.querySelector(".kodex-composer-underbar-left svg")).toBeInTheDocument();
  });

  it("lets draft composers choose between chats and projects from the underbar", async () => {
    const attachmentInputRef = { current: null } as RefObject<HTMLInputElement | null>;
    const onProjectChange = vi.fn();

    renderWithQueryProvider(
      <MantineProvider>
        <ComposerPanel
          activeSelectedTurnId={null}
          attachmentInputRef={attachmentInputRef}
          canCompose
          composerResetToken={0}
          composerSettings={composerSettings}
          composerSettingsError={null}
          contextUsage={null}
          draftProjectSelector={{
            onChange: onProjectChange,
            projects: [{ id: "project-1", name: "Kodex" }],
            value: null,
          }}
          isDraftThreadSelected
          isDraftComposerTransitioning={false}
          isComposerDragActive={false}
          isComposerSubmitting={false}
          isSelectedTimelineReady
          models={[]}
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
          selectedThreadPresent={false}
        />
      </MantineProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: /project: no project/i }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /kodex/i }));

    expect(onProjectChange).toHaveBeenCalledWith("project-1");
  });

  it.each([undefined, null, "", "   "])(
    "omits the git branch underflow when the selected branch is unavailable",
    (selectedGitBranch) => {
      const attachmentInputRef = { current: null } as RefObject<HTMLInputElement | null>;

      renderWithQueryProvider(
        <MantineProvider>
          <ComposerPanel
            activeSelectedTurnId={null}
            attachmentInputRef={attachmentInputRef}
            canCompose
            composerResetToken={0}
            composerSettings={composerSettings}
            composerSettingsError={null}
            contextUsage={null}
            isDraftThreadSelected={false}
            isDraftComposerTransitioning={false}
            isComposerDragActive={false}
            isComposerSubmitting={false}
            isSelectedTimelineReady
            models={[]}
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
            selectedGitBranch={selectedGitBranch}
            selectedThreadPresent
          />
        </MantineProvider>,
      );

      expect(screen.queryByLabelText("Composer context")).not.toBeInTheDocument();
      expect(document.querySelector(".kodex-composer-underbar")).not.toBeInTheDocument();
    },
  );
});
