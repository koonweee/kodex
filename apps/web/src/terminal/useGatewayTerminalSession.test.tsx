import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createTerminalSession,
  deleteTerminalSession,
  listTerminalSessions,
  type CreateTerminalSession,
  type TerminalSessionInfo,
} from "../api/client";
import { type TerminalSessionApi, useGatewayTerminalSession } from "./useGatewayTerminalSession";

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

function HookProbe({
  api,
  createRequest,
  opened,
  preferredTerminalId,
  reuseRunning,
}: {
  api?: TerminalSessionApi;
  createRequest?: CreateTerminalSession;
  opened: boolean;
  preferredTerminalId?: string | null;
  reuseRunning?: boolean;
}) {
  const terminal = useGatewayTerminalSession(opened, { api, createRequest, preferredTerminalId, reuseRunning });
  return (
    <div>
      <span>{terminal.isLoading ? "loading" : "idle"}</span>
      <span>{terminal.session?.title ?? "no-session"}</span>
      {terminal.error ? <span role="alert">{terminal.error}</span> : null}
      <button onClick={terminal.recoverSession} type="button">Recover</button>
      <button onClick={terminal.stopSession} type="button">Stop</button>
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

  it("uses the provided API for creation, recovery, replacement and Stop without REST fallback", async () => {
    const api: TerminalSessionApi = {
      list: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValueOnce(session).mockResolvedValueOnce(replacementSession),
      delete: vi.fn().mockResolvedValue({ id: session.id }),
    };
    render(<HookProbe api={api} createRequest={{ projectId: "native-project" }} opened preferredTerminalId={session.id} reuseRunning={false} />);
    await screen.findByText(session.title);
    expect(api.create).toHaveBeenCalledWith({ projectId: "native-project" });
    vi.mocked(api.list).mockResolvedValue([session]);
    await userEvent.click(screen.getByRole("button", { name: "Recover" }));
    await screen.findByText(session.title);
    expect(api.list).toHaveBeenCalledTimes(2);
    await userEvent.click(screen.getByRole("button", { name: "New" }));
    await screen.findByText(replacementSession.title);
    expect(api.delete).toHaveBeenCalledWith(session.id);
    await userEvent.click(screen.getByRole("button", { name: "Stop" }));
    await screen.findByText("no-session");
    expect(api.delete).toHaveBeenLastCalledWith(replacementSession.id);
    expect(listTerminalSessions).not.toHaveBeenCalled();
    expect(createTerminalSession).not.toHaveBeenCalled();
    expect(deleteTerminalSession).not.toHaveBeenCalled();
  });

  it("reuses the requested native shell in two views and stops through the injected API", async () => {
    const api: TerminalSessionApi = {
      list: vi.fn().mockResolvedValue([session, replacementSession]),
      create: vi.fn(), delete: vi.fn().mockResolvedValue({ id: session.id }),
    };
    const first = render(<HookProbe api={api} opened preferredTerminalId={session.id} />);
    const second = render(<HookProbe api={api} opened preferredTerminalId={session.id} />);
    for (const view of [first, second]) await within(view.container).findByText(session.title);
    for (const view of [first, second]) {
      await userEvent.click(within(view.container).getByRole("button", { name: "Stop" }));
      await within(view.container).findByText("no-session");
    }
    expect(api.delete).toHaveBeenCalledTimes(2);
    expect(api.create).not.toHaveBeenCalled();
    expect(listTerminalSessions).not.toHaveBeenCalled();
    expect(deleteTerminalSession).not.toHaveBeenCalled();
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

  it("prefers a requested running terminal over other reusable sessions", async () => {
    vi.mocked(listTerminalSessions).mockResolvedValue([session, replacementSession]);

    render(<HookProbe opened preferredTerminalId="terminal-2" />);

    expect(await screen.findByText("replacement: /bin/zsh")).toBeInTheDocument();
    expect(createTerminalSession).not.toHaveBeenCalled();
  });

  it("converges when another view already stopped the shell", async () => {
    vi.mocked(listTerminalSessions).mockResolvedValue([session]);
    vi.mocked(deleteTerminalSession)
      .mockResolvedValueOnce({ id: session.id })
      .mockRejectedValueOnce(new Error(`terminal ${session.id} was not found`));
    const first = render(<HookProbe opened preferredTerminalId={session.id} />);
    const second = render(<HookProbe opened preferredTerminalId={session.id} />);
    for (const view of [first, second]) await within(view.container).findByText(session.title);
    await userEvent.click(within(first.container).getByRole("button", { name: "Stop" }));
    await within(first.container).findByText("no-session");
    await userEvent.click(within(second.container).getByRole("button", { name: "Stop" }));
    await within(second.container).findByText("no-session");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(createTerminalSession).not.toHaveBeenCalled();
  });

  it("keeps the shell available after an uncertain Stop failure", async () => {
    vi.mocked(listTerminalSessions).mockResolvedValue([session]);
    vi.mocked(deleteTerminalSession).mockRejectedValue(new Error("gateway unavailable"));
    render(<HookProbe opened preferredTerminalId={session.id} />);
    await screen.findByText(session.title);
    await userEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("gateway unavailable");
    expect(screen.getByText(session.title)).toBeInTheDocument();
    expect(createTerminalSession).not.toHaveBeenCalled();
  });

  it("creates a dedicated session when running session reuse is disabled", async () => {
    vi.mocked(listTerminalSessions).mockResolvedValue([session]);
    vi.mocked(createTerminalSession).mockResolvedValue(replacementSession);

    render(<HookProbe createRequest={{ cwd: "/tmp/worktree" }} opened reuseRunning={false} />);

    expect(await screen.findByText("replacement: /bin/zsh")).toBeInTheDocument();
    expect(createTerminalSession).toHaveBeenCalledWith({ cwd: "/tmp/worktree" });
  });
});
