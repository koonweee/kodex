import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  App,
  baseRoutes,
  mockGateway,
  project,
  requestJson,
  thread,
} from "./test/mvpAppHarness";

const timestamp = "2026-05-05T00:00:00Z";

function subsystem(overrides = {}) {
  return {
    adminAddress: "127.0.0.1:20191",
    adminReachable: true,
    bindAddress: "100.64.0.10",
    caddyFound: true,
    caddyRunning: true,
    lastReloadError: null,
    state: "available",
    ...overrides,
  };
}

function service(overrides = {}) {
  return {
    createdAt: timestamp,
    healthPath: "/health",
    id: "service-backend",
    localPort: 4000,
    name: "Backend",
    projectId: project.id,
    protocol: "http",
    status: {
      healthUrl: "http://127.0.0.1:4000/health",
      lastCheckedAt: timestamp,
      lastError: null,
      reachability: "reachable",
    },
    updatedAt: timestamp,
    ...overrides,
  };
}

function preview(overrides = {}) {
  return {
    createdAt: timestamp,
    enabled: true,
    id: "preview-app",
    name: "App",
    projectId: project.id,
    publicPort: 13000,
    rootServiceId: "service-frontend",
    routes: [
      {
        createdAt: timestamp,
        id: "route-api",
        pathPattern: "/api/*",
        previewId: "preview-app",
        serviceId: "service-backend",
        sortOrder: 0,
        stripPrefix: true,
        updatedAt: timestamp,
      },
    ],
    status: {
      lastReloadError: null,
      publicPort: 13000,
      routeErrors: [],
      state: "active",
      url: "http://100.64.0.10:13000",
    },
    updatedAt: timestamp,
    ...overrides,
  };
}

describe("project preview settings", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("opens project settings and applies preview service changes through gateway state", async () => {
    let services = [service({ id: "service-frontend", localPort: 3000, name: "Frontend" }), service()];
    const previews = [preview()];
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/threads": { threads: [thread], nextCursor: null, backwardsCursor: null, rawPayload: {} },
        "GET /v1/projects/project-1/previews": () => ({
          previews,
          projectId: project.id,
          services,
          subsystem: subsystem(),
        }),
        "POST /v1/projects/project-1/preview-services": async (request: Request) => {
          const body = (await requestJson(request)) as { healthPath: string; localPort: number; name: string; protocol: string };
          const createdService = service({
            healthPath: body.healthPath,
            id: "service-worker",
            localPort: body.localPort,
            name: body.name,
            protocol: body.protocol,
            status: {
              healthUrl: `http://127.0.0.1:${body.localPort}${body.healthPath}`,
              lastCheckedAt: timestamp,
              lastError: null,
              reachability: "unknown",
            },
          });
          services = [...services, createdService];
          return { service: createdService, subsystem: subsystem() };
        },
        "POST /v1/project-previews/reload": () => subsystem({ caddyRunning: true }),
      }),
    );

    render(<App />);

    await userEvent.click(await screen.findByRole("button", { name: /project settings for kodex/i }));

    expect(window.location.pathname).toBe("/projects/project-1");
    const main = await screen.findByRole("main", { name: /project/i });
    expect(await within(main).findByRole("heading", { name: "Kodex" })).toBeInTheDocument();
    expect(await within(main).findByText("Preview subsystem")).toBeInTheDocument();
    expect(await within(main).findByText("Frontend")).toBeInTheDocument();
    expect(await within(main).findByText("Backend")).toBeInTheDocument();
    expect(await within(main).findByRole("link", { name: /open http:\/\/100\.64\.0\.10:13000/i })).toHaveAttribute(
      "href",
      "http://100.64.0.10:13000",
    );
    expect(await within(main).findByText("/api/*")).toBeInTheDocument();

    await userEvent.type(screen.getAllByLabelText("Name")[0], "Worker");
    await userEvent.type(screen.getByLabelText(/local port/i), "5173");
    await userEvent.clear(screen.getByLabelText(/health path/i));
    await userEvent.type(screen.getByLabelText(/health path/i), "/ready");
    await userEvent.click(screen.getByRole("button", { name: /add service/i }));

    await waitFor(() => {
      expect(gateway.callsFor("POST", "/v1/projects/project-1/preview-services")).toHaveLength(1);
    });
    await expect(requestJson(gateway.callsFor("POST", "/v1/projects/project-1/preview-services")[0])).resolves.toEqual({
      healthPath: "/ready",
      localPort: 5173,
      name: "Worker",
      protocol: "http",
    });
    expect(await within(main).findByText("Worker")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /restart proxy/i }));
    await waitFor(() => {
      expect(gateway.callsFor("POST", "/v1/project-previews/reload")).toHaveLength(1);
    });
  });
});
