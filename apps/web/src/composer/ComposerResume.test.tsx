import { MantineProvider } from "@mantine/core";
import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { createKodexQueryClient } from "../api/queryClient";
import { ComposerPanel, type ComposerPanelProps } from "./ComposerPanel";

function composer(overrides: Partial<ComposerPanelProps> = {}) {
  const onResumeTurn = vi.fn();
  const onSubmitTurn = vi.fn((event) => event.preventDefault());
  const props: ComposerPanelProps = {
    activeSelectedTurnId: null, attachmentInputRef: {current:null}, canCompose: true,
    composerSettings: {fast:false}, composerSettingsError: null, composerResetToken: 0,
    isDraftThreadSelected: false, isDraftComposerTransitioning: false, isComposerDragActive: false,
    isComposerSubmitting: false, isSelectedTimelineReady: true, models: [],
    onAttachmentInputChange: vi.fn(), onComposerDragLeave: vi.fn(), onComposerDragOver: vi.fn(),
    onComposerDrop: vi.fn(), onComposerKeyDown: vi.fn(), onComposerPaste: vi.fn(),
    onComposerSettingsChange: vi.fn(), onImageOpen: vi.fn(), onRemovePendingAttachment: vi.fn(),
    onStopTurn: vi.fn(), onSubmitTurn, pendingAttachments: [], selectedThreadPresent: true,
    resumableTurnId: "stopped", onResumeTurn, ...overrides,
  };
  render(<QueryClientProvider client={createKodexQueryClient()}><MantineProvider env="test"><ComposerPanel {...props} /></MantineProvider></QueryClientProvider>);
  return {onResumeTurn,onSubmitTurn};
}
describe("composer Resume", () => {
  it("replaces empty Send with Resume and invokes continuation without submitting text", async () => {
    const actions=composer();
    expect(screen.queryByRole("button",{name:"Send message"})).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button",{name:"Resume turn"}));
    expect(actions.onResumeTurn).toHaveBeenCalledTimes(1);
    expect(actions.onSubmitTurn).not.toHaveBeenCalled();
  });
  it("switches to normal Send while typing, and back to Resume when cleared", async () => {
    composer();
    const field=screen.getByRole("textbox",{name:"Message composer"});
    await userEvent.type(field,"Continue with a different approach");
    expect(screen.queryByRole("button",{name:"Resume turn"})).not.toBeInTheDocument();
    expect(screen.getByRole("button",{name:"Send message"})).toBeEnabled();
    await userEvent.clear(field);
    expect(screen.getByRole("button",{name:"Resume turn"})).toBeEnabled();
  });
  it("treats attachments as ordinary Send input", () => {
    composer({pendingAttachments:[{id:"file",kind:"file",file:new File(["notes"],"notes.txt"),status:"pending"}]});
    expect(screen.queryByRole("button",{name:"Resume turn"})).not.toBeInTheDocument();
    expect(screen.getByRole("button",{name:"Send message"})).toBeEnabled();
  });
  it.each([{resumableTurnId:null},{activeSelectedTurnId:"active"},{selectedThreadPresent:false,isDraftThreadSelected:true}])("does not offer Resume outside an idle interrupted existing conversation: %o", (props) => {
    composer(props);
    expect(screen.queryByRole("button",{name:"Resume turn"})).not.toBeInTheDocument();
  });
  it("disables Resume until the pane is ready", () => {
    composer({isSelectedTimelineReady:false});
    expect(screen.getByRole("button",{name:"Resume turn"})).toBeDisabled();
  });
});
