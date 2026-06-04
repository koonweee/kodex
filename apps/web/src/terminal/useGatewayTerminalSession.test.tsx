import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createTerminalSession,
  deleteTerminalSession,
  listTerminalSessions,
  type TerminalSessionInfo,
} from "../api/client";
import { useGatewayTerminalSession } from "./useGatewayTerminalSession";

vi.mock("../api/client", async (importActual) => {
  const actual = await importActual<typeof import("../api/client")>();
  return {
    ...actual,
    createTerminalSession: vi.fn(),
    deleteTerminalSession: vi.fn(),
    listTerminalSessions: vi.fn(),
  };
});

const session: TerminalSessionInfo = {
  command: "/bin/zsh",
  createdAt: "2026-06-04T20:00:00Z",
  cwd: "/Users/example",
  historySizeBytes: 0,
  id: "terminal-1",
  status: "running",
  title: "example: /bin/zsh",
};
const replacementSession: TerminalSessionInfo = {
  ...session,
  id: "terminal-2",
  title: "replacement: /bin/zsh",
};

function HookProbe({ opened }: { opened: boolean }) {
  const terminal = useGatewayTerminalSession(opened);
  return (
    <div>
      <span>{terminal.isLoading ? "loading" : "idle"}</span>
      <span>{terminal.session?.title ?? "no-session"}</span>
      <button onClick={terminal.createNewSession} type="button">
        New
      </button>
    </div>
  );
}

describe("useGatewayTerminalSession", () => {
  beforeEach(() => {
    vi.mocked(createTerminalSession).mockReset();
    vi.mocked(deleteTerminalSession).mockReset();
    vi.mocked(listTerminalSessions).mockReset();
  });

  it("commits the ensured session after setting loading state", async () => {
    vi.mocked(listTerminalSessions).mockResolvedValue([]);
    vi.mocked(createTerminalSession).mockResolvedValue(session);

    render(<HookProbe opened />);

    expect(await screen.findByText("example: /bin/zsh")).toBeInTheDocument();
    expect(screen.getByText("idle")).toBeInTheDocument();
    expect(createTerminalSession).toHaveBeenCalledTimes(1);
  });

  it("revalidates the cached session each time the host opens", async () => {
    vi.mocked(listTerminalSessions).mockResolvedValueOnce([]).mockResolvedValueOnce([replacementSession]);
    vi.mocked(createTerminalSession).mockResolvedValue(session);

    const { rerender } = render(<HookProbe opened />);
    expect(await screen.findByText("example: /bin/zsh")).toBeInTheDocument();

    rerender(<HookProbe opened={false} />);
    rerender(<HookProbe opened />);

    expect(await screen.findByText("replacement: /bin/zsh")).toBeInTheDocument();
    expect(listTerminalSessions).toHaveBeenCalledTimes(2);
  });

  it("deletes the current session before creating a replacement", async () => {
    vi.mocked(listTerminalSessions).mockResolvedValue([]);
    vi.mocked(createTerminalSession).mockResolvedValueOnce(session).mockResolvedValueOnce(replacementSession);
    vi.mocked(deleteTerminalSession).mockResolvedValue({ id: "terminal-1" });

    render(<HookProbe opened />);
    expect(await screen.findByText("example: /bin/zsh")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "New" }));

    expect(await screen.findByText("replacement: /bin/zsh")).toBeInTheDocument();
    expect(deleteTerminalSession).toHaveBeenCalledWith("terminal-1");
  });
});
