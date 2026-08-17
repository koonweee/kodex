#!/usr/bin/env node
import { chromium, devices } from "@playwright/test";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(SCRIPT_DIR, "..");
const REPO_ROOT = path.resolve(WEB_DIR, "../..");
const DIST_DIR = path.join(WEB_DIR, "dist");
const OUT_ROOT = path.join(REPO_ROOT, "tmp", "dockview-profiling");
const RUN_ID = new Date().toISOString().replace(/[:.]/g, "-");
const OUT_DIR = path.join(OUT_ROOT, RUN_ID);
const cliOptions = parseCliOptions(process.argv.slice(2));
const COMPOSER_TYPING_TEXT = "Profile prompt ".repeat(cliOptions.typingRepeat);
const TRACE_CATEGORIES = [
  "devtools.timeline",
  "v8.execute",
  "blink.user_timing",
  "latencyInfo",
  "renderer.scheduler",
  "toplevel",
].join(",");

const project = {
  id: "project-1",
  name: "Kodex",
  cwd: process.cwd(),
  createdAt: "2026-06-05T00:00:00Z",
  updatedAt: "2026-06-05T00:00:00Z",
};

const threadSummaries = [
  threadSummary("thread-1", "Frontend MVP", "Build the web client", "idle"),
  threadSummary("thread-2", "Second pane investigation", "Compare pane subscriptions", "idle"),
  threadSummary("thread-3", "Approval heavy flow", "Approval card and timeline", "idle"),
  threadSummary("thread-4", "Generated UI review", "Generated UI surface available", "idle"),
  threadSummary("thread-long", "Long timeline rendering", "Large thread with tool output", "idle"),
  threadSummary("thread-stream", "Long running active turn", "Streaming answer in progress", "active"),
];

const scenarios = [
  {
    id: "desktop-cold-draft",
    label: "Desktop cold draft shell",
    viewport: { width: 1440, height: 900 },
    path: "/",
    scenario: "baseline",
    matrix: "Cold app shell with one draft pane and sidebar data.",
    action: async ({ page }) => {
      await page.getByLabel(/message composer/i).first().waitFor({ state: "visible" });
    },
  },
  {
    id: "desktop-short-thread",
    label: "Desktop selected thread",
    viewport: { width: 1440, height: 900 },
    path: "/threads/thread-1",
    scenario: "short",
    matrix: "Existing thread load with one Dockview thread pane.",
    action: async ({ page }) => {
      await expectText(page, /Profile answer 1/);
    },
  },
  {
    id: "desktop-long-timeline",
    label: "Desktop long timeline scroll",
    viewport: { width: 1440, height: 900 },
    path: "/threads/thread-long",
    scenario: "long",
    matrix: "One Dockview pane with 640 canonical timeline rows, file diffs, commands, and markdown.",
    action: async ({ page }) => {
      await waitForTimelineRows(page);
      await scrollTimeline(page, 5200);
      await page.waitForTimeout(250);
      await scrollTimeline(page, -2400);
    },
  },
  {
    id: "desktop-four-thread-panes",
    label: "Desktop four thread panes",
    viewport: { width: 1600, height: 900 },
    path: "/threads/thread-1",
    scenario: "multi-thread",
    seedWorkspace: workspaceState([
      threadPane("pane-thread-1", "thread-1", "Frontend MVP"),
      threadPane("pane-thread-2", "thread-2", "Second pane investigation"),
      threadPane("pane-thread-3", "thread-3", "Approval heavy flow"),
      threadPane("pane-thread-long", "thread-long", "Long timeline rendering"),
    ], "pane-thread-long"),
    matrix: "Four simultaneous Dockview thread panes, including one long timeline.",
    action: async ({ page }) => {
      await waitForPaneCount(page, 4);
      await waitForTimelineRows(page);
      await clickDockTabs(page);
      await scrollTimeline(page, 3600);
    },
  },
  {
    id: "desktop-mixed-panes",
    label: "Desktop mixed pane types",
    viewport: { width: 1720, height: 940 },
    path: "/threads/thread-1",
    scenario: "mixed",
    seedWorkspace: workspaceState([
      threadPane("pane-thread-long", "thread-long", "Long timeline rendering"),
      generatedUiPane("pane-ui-1", "thread-1", "Generated UI"),
      terminalPane("pane-terminal-1"),
      threadPane("pane-thread-stream", "thread-stream", "Long running active turn"),
    ], "pane-thread-long"),
    matrix: "Thread, generated UI iframe, terminal/xterm, and active thread panes in one Dockview layout.",
    action: async ({ page }) => {
      await waitForPaneCount(page, 4);
      await page.locator(".kodex-generated-ui-pane iframe").first().waitFor({ state: "visible" });
      await page.locator(".kodex-terminal-pane").first().waitFor({ state: "visible" });
      await scrollTimeline(page, 3200);
      await page.locator(".kodex-generated-ui-pane").first().click();
    },
  },
  {
    id: "desktop-stream-heavy",
    label: "Desktop streaming active turn",
    viewport: { width: 1440, height: 900 },
    path: "/threads/thread-stream",
    scenario: "stream-heavy",
    matrix: "Long-running active turn with SSE item deltas applied to the active pane.",
    action: async ({ page }) => {
      await expectText(page, /Streaming seed/);
      await expectText(page, /token-119/, 10000);
    },
  },
  {
    id: "desktop-pane-ops",
    label: "Desktop pane open and focus churn",
    viewport: { width: 1600, height: 900 },
    path: "/threads/thread-1",
    scenario: "short",
    matrix: "Repeated duplicate-pane and generated-UI pane creation from thread chrome.",
    action: async ({ page }) => {
      await expectText(page, /Profile answer 1/);
      for (let index = 0; index < 3; index += 1) {
        await page.getByRole("button", { name: /duplicate pane/i }).first().click();
        await page.waitForTimeout(120);
      }
      await page.getByRole("button", { name: /open generated ui/i }).first().click();
      await waitForPaneCount(page, 5);
      await page.locator(".kodex-generated-ui-pane iframe").first().waitFor({ state: "visible" });
    },
  },
  {
    id: "desktop-composer-typing-single",
    label: "Desktop composer typing, single pane",
    viewport: { width: 1440, height: 900 },
    path: "/threads/thread-1",
    scenario: "short",
    seedWorkspace: workspaceState([
      threadPane("pane-thread-1", "thread-1", "Frontend MVP"),
    ], "pane-thread-1"),
    matrix: "Typing a prompt into a single Dockview-hosted thread composer.",
    action: async ({ page }) => {
      await expectText(page, /Profile answer 1/);
      await profileComposerTyping(page, COMPOSER_TYPING_TEXT);
    },
  },
  {
    id: "desktop-composer-typing",
    label: "Desktop composer typing, two panes",
    viewport: { width: 1440, height: 900 },
    path: "/threads/thread-1",
    scenario: "short",
    seedWorkspace: workspaceState([
      threadPane("pane-thread-1", "thread-1", "Frontend MVP"),
      threadPane("pane-thread-2", "thread-2", "Second pane investigation"),
    ], "pane-thread-1"),
    matrix: "Typing a prompt into a Dockview-hosted thread composer while a second thread pane is mounted.",
    action: async ({ page }) => {
      await expectText(page, /Profile answer 1/);
      await profileComposerTyping(page, COMPOSER_TYPING_TEXT);
    },
  },
  {
    id: "mobile-composer-typing",
    label: "Mobile composer typing, expanded",
    mobile: true,
    viewport: { width: 390, height: 844 },
    path: "/threads/thread-1",
    scenario: "short",
    matrix: "Typing a prompt in the narrow touch-style expanded composer without Dockview chrome.",
    action: async ({ page }) => {
      await waitForTimelineRows(page);
      await profileComposerTyping(page, COMPOSER_TYPING_TEXT, { expandMobileComposer: true });
    },
  },
  {
    id: "mobile-short-thread",
    label: "Mobile selected thread",
    mobile: true,
    viewport: { width: 390, height: 844 },
    path: "/threads/thread-1",
    scenario: "short",
    matrix: "Narrow single-thread path, used as the non-Dockview mobile comparison.",
    action: async ({ page }) => {
      await waitForTimelineRows(page);
    },
  },
  {
    id: "mobile-long-timeline",
    label: "Mobile long timeline scroll",
    mobile: true,
    viewport: { width: 390, height: 844 },
    path: "/threads/thread-long",
    scenario: "long",
    matrix: "Narrow single-thread path with the same long timeline dataset.",
    action: async ({ page }) => {
      await waitForTimelineRows(page);
      await scrollTimeline(page, 5200);
      await page.waitForTimeout(250);
      await scrollTimeline(page, -2200);
    },
  },
  {
    id: "mobile-generated-ui-toggle",
    label: "Mobile generated UI toggle",
    mobile: true,
    viewport: { width: 390, height: 844 },
    path: "/threads/thread-1",
    scenario: "mixed",
    matrix: "Narrow generated-UI surface toggle from thread header.",
    action: async ({ page }) => {
      await waitForTimelineRows(page);
      await page.getByRole("button", { name: /show app surface/i }).click({ timeout: 10000 });
      await page.locator(".kodex-generated-ui-pane iframe").first().waitFor({ state: "visible" });
    },
  },
];

const agentBrowserAvailable = spawnSync("agent-browser", ["--version"], { stdio: "ignore" }).status === 0;
const shouldRunAgentBrowserProfiles = process.argv.includes("--agent-browser");

await main();

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  if (cliOptions.skipBuild) {
    console.log("[profile] skipping production build");
  } else {
    await buildFrontend();
  }

  const port = await freePort();
  const server = await startProfileServer(port);
  const baseUrl = `http://127.0.0.1:${port}`;
  const results = [];

  try {
    for (const scenario of filteredScenarios()) {
      console.log(`\n[profile] ${scenario.id}`);
      results.push(await runScenario(baseUrl, scenario));
    }
    let agentProfiles = [{
      id: "agent-browser",
      ok: false,
      error: !agentBrowserAvailable
        ? "agent-browser was not found on PATH"
        : shouldRunAgentBrowserProfiles
          ? "not yet collected"
          : "skipped by default; rerun with --agent-browser to collect optional CLI profiles",
    }];
    await writeReports({ agentProfiles, baseUrl, results });
    agentProfiles = agentBrowserAvailable && shouldRunAgentBrowserProfiles
      ? await runAgentBrowserProfiles(baseUrl)
      : agentProfiles;
    await writeReports({ agentProfiles, baseUrl, results });
  } finally {
    await server.close();
  }

  console.log(`\nProfile run complete: ${OUT_DIR}`);
}

async function buildFrontend() {
  console.log("[profile] building production frontend");
  await runProcess("npm", ["run", "build"], { cwd: WEB_DIR, env: { ...process.env, VITE_KODEX_API_BASE_URL: "" } });
}

function filteredScenarios() {
  if (cliOptions.only.length === 0) {
    return scenarios;
  }
  const selected = new Set(cliOptions.only);
  const filtered = scenarios.filter((scenario) => selected.has(scenario.id));
  const missing = [...selected].filter((id) => !scenarios.some((scenario) => scenario.id === id));
  if (missing.length > 0) {
    throw new Error(`Unknown --only scenario id(s): ${missing.join(", ")}`);
  }
  return filtered;
}

function parseCliOptions(args) {
  const options = {
    only: [],
    colorScheme: null,
    skipBuild: false,
    typingDelayMs: 1,
    typingRepeat: 90,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--skip-build") {
      options.skipBuild = true;
      continue;
    }
    if (arg === "--agent-browser") {
      continue;
    }
    if (arg === "--color-scheme") {
      options.colorScheme = args[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg.startsWith("--color-scheme=")) {
      options.colorScheme = arg.slice("--color-scheme=".length);
      continue;
    }
    if (arg === "--only") {
      options.only = splitListOption(args[index + 1] ?? "");
      index += 1;
      continue;
    }
    if (arg.startsWith("--only=")) {
      options.only = splitListOption(arg.slice("--only=".length));
      continue;
    }
    if (arg === "--typing-delay") {
      options.typingDelayMs = numberOption(args[index + 1], "--typing-delay");
      index += 1;
      continue;
    }
    if (arg.startsWith("--typing-delay=")) {
      options.typingDelayMs = numberOption(arg.slice("--typing-delay=".length), "--typing-delay");
      continue;
    }
    if (arg === "--typing-repeat") {
      options.typingRepeat = numberOption(args[index + 1], "--typing-repeat");
      index += 1;
      continue;
    }
    if (arg.startsWith("--typing-repeat=")) {
      options.typingRepeat = numberOption(arg.slice("--typing-repeat=".length), "--typing-repeat");
      continue;
    }
    throw new Error(`Unknown profile option: ${arg}`);
  }
  return options;
}

function splitListOption(value) {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function numberOption(value, name) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative number.`);
  }
  return parsed;
}

async function runScenario(baseUrl, scenario) {
  await setServerScenario(baseUrl, scenario.scenario);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext(contextOptions(scenario));
  await installPerfObserver(context, scenario.seedWorkspace, cliOptions.colorScheme);
  const page = await context.newPage();
  const client = await context.newCDPSession(page);
  const errors = [];
  const failedRequests = [];
  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type())) {
      errors.push(`${message.type()}: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("requestfailed", (request) => failedRequests.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? ""}`));
  page.on("response", (response) => {
    if (response.status() >= 400) {
      failedRequests.push(`${response.status()} ${response.request().method()} ${response.url()}`);
    }
  });

  await client.send("Performance.enable").catch(() => undefined);
  const tracePath = path.join(OUT_DIR, `${scenario.id}.trace.json`);
  const screenshotPath = path.join(OUT_DIR, `${scenario.id}.png`);
  const startedAt = Date.now();

  try {
    await startChromeTrace(client);
    await page.goto(`${baseUrl}${scenario.path}`, { waitUntil: "domcontentloaded" });
    await scenario.action({ page });
    await settle(page);
    await page.screenshot({ path: screenshotPath, fullPage: false });
  } catch (error) {
    errors.push(`scenario failure: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await stopChromeTrace(client, tracePath).catch((error) => {
      errors.push(`trace failure: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  const metrics = await collectMetrics(page, client);
  const result = {
    id: scenario.id,
    label: scenario.label,
    matrix: scenario.matrix,
    mode: scenario.mobile ? "mobile" : "desktop",
    durationMs: Date.now() - startedAt,
    viewport: scenario.viewport,
    tracePath: rel(tracePath),
    screenshotPath: rel(screenshotPath),
    errors: unique(errors).slice(0, 20),
    failedRequests: unique(failedRequests).slice(0, 20),
    ...metrics,
  };

  await context.close();
  await browser.close();
  console.log(formatOneLineResult(result));
  return result;
}

async function profileComposerTyping(page, text, options = {}) {
  await installComposerTypingProbe(page);
  const composer = page.getByLabel(/message composer/i).last();
  await composer.click();
  if (options.expandMobileComposer) {
    await page.getByRole("dialog", { name: /compose/i }).waitFor({ state: "visible" });
    await page.getByLabel(/message composer/i).last().waitFor({ state: "visible" });
  }
  await page.evaluate(() => {
    window.__kodexProfile.composerTyping.startedAt = performance.now();
  });
  await page.keyboard.type(text, { delay: cliOptions.typingDelayMs });
  await page.evaluate(() => {
    window.__kodexProfile.composerTyping.finishedAt = performance.now();
  });
  await page.waitForTimeout(250);
}

async function installComposerTypingProbe(page) {
  await page.evaluate(() => {
    const samples = [];
    const profile = {
      finishedAt: null,
      inputEventCount: 0,
      inputToFrameAvgMs: 0,
      inputToFrameMaxMs: 0,
      inputToFrameSamples: samples,
      keydownCount: 0,
      keyupCount: 0,
      mutationBatchCount: 0,
      mutationCount: 0,
      startedAt: null,
    };
    const observer = new MutationObserver((records) => {
      profile.mutationBatchCount += 1;
      profile.mutationCount += records.length;
    });
    observer.observe(document.body, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    });
    document.addEventListener("keydown", (event) => {
      if (event.target instanceof HTMLTextAreaElement && event.target.getAttribute("aria-label") === "Message composer") {
        profile.keydownCount += 1;
      }
    }, true);
    document.addEventListener("keyup", (event) => {
      if (event.target instanceof HTMLTextAreaElement && event.target.getAttribute("aria-label") === "Message composer") {
        profile.keyupCount += 1;
      }
    }, true);
    document.addEventListener("input", (event) => {
      if (!(event.target instanceof HTMLTextAreaElement) || event.target.getAttribute("aria-label") !== "Message composer") {
        return;
      }
      profile.inputEventCount += 1;
      const started = performance.now();
      requestAnimationFrame(() => {
        const sample = performance.now() - started;
        samples.push(sample);
        profile.inputToFrameMaxMs = Math.max(profile.inputToFrameMaxMs, sample);
        profile.inputToFrameAvgMs = samples.reduce((sum, value) => sum + value, 0) / samples.length;
      });
    }, true);
    window.__kodexProfile.composerTyping = profile;
  });
}

function contextOptions(scenario) {
  const colorScheme = cliOptions.colorScheme === "paper-light" ? "light" : "dark";
  if (!scenario.mobile) {
    return {
      colorScheme,
      deviceScaleFactor: 1,
      viewport: scenario.viewport,
    };
  }
  return {
    ...devices["iPhone 14"],
    colorScheme,
    viewport: scenario.viewport,
  };
}

async function installPerfObserver(context, seedWorkspace, colorScheme) {
  await context.addInitScript(({ seed, scheme }) => {
    window.__kodexProfile = {
      longTasks: [],
      layoutShifts: [],
    };
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          window.__kodexProfile.longTasks.push({
            duration: entry.duration,
            name: entry.name,
            startTime: entry.startTime,
          });
        }
      }).observe({ type: "longtask", buffered: true });
    } catch {
      // Not all browser contexts expose Long Tasks.
    }
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (!entry.hadRecentInput) {
            window.__kodexProfile.layoutShifts.push({
              startTime: entry.startTime,
              value: entry.value,
            });
          }
        }
      }).observe({ type: "layout-shift", buffered: true });
    } catch {
      // Layout shift is advisory for this app-shell profiling run.
    }
    if (window === window.top) {
      try {
        window.localStorage.clear();
        if (scheme) {
          window.localStorage.setItem("kodex-color-scheme", scheme);
        }
        if (seed) {
          window.localStorage.setItem("kodex.workspace.panes.v1", JSON.stringify(seed));
        }
      } catch {
        // Storage can be unavailable in restricted profiling contexts.
      }
    }
  }, { seed: seedWorkspace ?? null, scheme: colorScheme ?? null });
}

async function collectMetrics(page, client) {
  const cdp = await client.send("Performance.getMetrics").catch(() => ({ metrics: [] }));
  const cdpMetrics = Object.fromEntries((cdp.metrics ?? []).map((metric) => [metric.name, metric.value]));
  const pageMetrics = await page.evaluate(() => {
    const nav = performance.getEntriesByType("navigation")[0];
    const paint = Object.fromEntries(performance.getEntriesByType("paint").map((entry) => [entry.name, entry.startTime]));
    const profile = window.__kodexProfile ?? { longTasks: [], layoutShifts: [] };
    const longTasks = profile.longTasks ?? [];
    const layoutShifts = profile.layoutShifts ?? [];
    const liveDiagnostics = typeof window.__KODEX_LIVE_DIAGNOSTICS__ === "function"
      ? window.__KODEX_LIVE_DIAGNOSTICS__()
      : null;
    const composerTyping = profile.composerTyping ?? null;
    const composerTypingActionMs = composerTyping?.finishedAt && composerTyping?.startedAt
      ? composerTyping.finishedAt - composerTyping.startedAt
      : null;
    const paneHosts = document.querySelectorAll(".kodex-workspace-pane-host").length;
    const timelineRows = document.querySelectorAll(".kodex-timeline-virtual-row").length;
    return {
      composerTyping: composerTyping
        ? {
            actionMs: composerTypingActionMs,
            inputEventCount: composerTyping.inputEventCount,
            inputToFrameAvgMs: composerTyping.inputToFrameAvgMs,
            inputToFrameMaxMs: composerTyping.inputToFrameMaxMs,
            keydownCount: composerTyping.keydownCount,
            keyupCount: composerTyping.keyupCount,
            mutationBatchCount: composerTyping.mutationBatchCount,
            mutationCount: composerTyping.mutationCount,
          }
        : null,
      domElements: document.getElementsByTagName("*").length,
      dockviewPanes: paneHosts,
      fcpMs: paint["first-contentful-paint"] ?? null,
      iframeCount: document.querySelectorAll("iframe").length,
      liveDiagnostics,
      longTaskCount: longTasks.length,
      longTaskMaxMs: longTasks.reduce((max, task) => Math.max(max, task.duration), 0),
      longTaskTotalMs: longTasks.reduce((sum, task) => sum + task.duration, 0),
      cls: layoutShifts.reduce((sum, shift) => sum + shift.value, 0),
      navigationLoadMs: nav ? nav.loadEventEnd - nav.startTime : null,
      timelineRows,
      url: window.location.href,
    };
  });
  return {
    ...pageMetrics,
    jsHeapUsedMb: bytesToMb(cdpMetrics.JSHeapUsedSize),
    jsHeapTotalMb: bytesToMb(cdpMetrics.JSHeapTotalSize),
    cdpDocuments: cdpMetrics.Documents ?? null,
    cdpFrames: cdpMetrics.Frames ?? null,
    cdpNodes: cdpMetrics.Nodes ?? null,
    cdpLayoutCount: cdpMetrics.LayoutCount ?? null,
    cdpLayoutDurationMs: secondsToMs(cdpMetrics.LayoutDuration),
    cdpRecalcStyleCount: cdpMetrics.RecalcStyleCount ?? null,
    cdpRecalcStyleDurationMs: secondsToMs(cdpMetrics.RecalcStyleDuration),
    cdpScriptDurationMs: secondsToMs(cdpMetrics.ScriptDuration),
    cdpTaskDurationMs: secondsToMs(cdpMetrics.TaskDuration),
  };
}

async function startChromeTrace(client) {
  await client.send("Tracing.start", {
    categories: TRACE_CATEGORIES,
    options: "sampling-frequency=10000",
    transferMode: "ReturnAsStream",
  });
}

async function stopChromeTrace(client, tracePath) {
  const complete = new Promise((resolve) => client.once("Tracing.tracingComplete", resolve));
  await client.send("Tracing.end");
  const event = await complete;
  if (!event.stream) {
    await fs.writeFile(tracePath, JSON.stringify({ traceEvents: [] }));
    return;
  }
  let trace = "";
  for (;;) {
    const chunk = await client.send("IO.read", { handle: event.stream });
    trace += chunk.data ?? "";
    if (chunk.eof) {
      break;
    }
  }
  await client.send("IO.close", { handle: event.stream }).catch(() => undefined);
  await fs.writeFile(tracePath, trace);
}

async function runAgentBrowserProfiles(baseUrl) {
  const profileDir = path.join(OUT_DIR, "agent-browser");
  await fs.mkdir(profileDir, { recursive: true });
  const profiles = [];

  const cases = [
    {
      id: "agent-desktop-long-timeline",
      scenario: "long",
      viewport: ["1440", "900"],
      path: "/threads/thread-long",
      setup: null,
      actions: [
        ["wait", "--fn", "document.querySelectorAll('.kodex-timeline-virtual-row').length > 0"],
        ["scroll", "down", "5200"],
        ["wait", "250"],
        ["scroll", "up", "2400"],
      ],
    },
    {
      id: "agent-desktop-mixed-panes",
      scenario: "mixed",
      viewport: ["1720", "940"],
      path: "/threads/thread-1",
      setup: workspaceState([
        threadPane("pane-thread-long", "thread-long", "Long timeline rendering"),
        generatedUiPane("pane-ui-1", "thread-1", "Generated UI"),
        terminalPane("pane-terminal-1"),
        threadPane("pane-thread-stream", "thread-stream", "Long running active turn"),
      ], "pane-thread-long"),
      actions: [
        ["wait", "--fn", "document.querySelectorAll('.kodex-workspace-pane-host').length >= 4"],
        ["scroll", "down", "3200"],
        ["wait", "250"],
      ],
    },
    {
      id: "agent-mobile-long-timeline",
      scenario: "long",
      device: "iPhone 14",
      path: "/threads/thread-long",
      setup: null,
      actions: [
        ["wait", "--fn", "document.querySelectorAll('.kodex-timeline-virtual-row').length > 0"],
        ["scroll", "down", "4200"],
        ["wait", "250"],
      ],
    },
  ];

  for (const item of cases) {
    const session = `kodex-profile-${item.id}`;
    const tracePath = path.join(profileDir, `${item.id}.json`);
    const screenshotPath = path.join(profileDir, `${item.id}.png`);
    try {
      await setServerScenario(baseUrl, item.scenario);
      await agent(["--session", session, "close"]).catch(() => undefined);
      if (item.device) {
        await agent(["--session", session, "set", "device", item.device]);
      } else {
        await agent(["--session", session, "set", "viewport", ...item.viewport]);
      }
      if (item.setup) {
        await agent(["--session", session, "open", `${baseUrl}/`]);
        await agent([
          "--session",
          session,
          "eval",
          `localStorage.setItem("kodex.workspace.panes.v1", ${JSON.stringify(JSON.stringify(item.setup))});`,
        ]);
      }
      await agent(["--session", session, "profiler", "start"]);
      await agent(["--session", session, "open", `${baseUrl}${item.path}`]);
      for (const command of item.actions) {
        await agent(["--session", session, ...command]);
      }
      await agent(["--session", session, "screenshot", screenshotPath]);
      await agent(["--session", session, "profiler", "stop", tracePath]);
      await agent(["--session", session, "close"]).catch(() => undefined);
      profiles.push({ id: item.id, ok: true, screenshotPath: rel(screenshotPath), tracePath: rel(tracePath) });
    } catch (error) {
      profiles.push({ id: item.id, ok: false, error: error instanceof Error ? error.message : String(error), tracePath: rel(tracePath) });
    }
  }
  return profiles;
}

async function agent(args) {
  await runProcess("agent-browser", args, { cwd: REPO_ROOT, quiet: true, timeoutMs: 25000 });
}

async function writeReports({ agentProfiles, baseUrl, results }) {
  const jsonPath = path.join(OUT_DIR, "results.json");
  const reportPath = path.join(OUT_DIR, "report.md");
  const payload = {
    agentProfiles,
    baseUrl,
    generatedAt: new Date().toISOString(),
    results,
  };
  await fs.writeFile(jsonPath, `${JSON.stringify(payload, null, 2)}\n`);
  await fs.writeFile(reportPath, renderReport(payload));
}

function renderReport({ agentProfiles, baseUrl, generatedAt, results }) {
  const concerns = detectConcerns(results);
  const composerResults = results.filter((result) => result.composerTyping);
  const lines = [
    "# Dockview Profiling Report",
    "",
    `Generated: ${generatedAt}`,
    `Target: ${baseUrl}`,
    `Mode: production build served by a same-origin mock gateway`,
    "",
    "## Profiling Matrix",
    "",
    "| ID | View | Flow | Coverage |",
    "| --- | --- | --- | --- |",
    ...scenarios.map((scenario) => `| ${scenario.id} | ${scenario.mobile ? "mobile" : "desktop"} | ${scenario.label} | ${scenario.matrix} |`),
    "",
    "## Results",
    "",
    "| ID | Duration | Heap | DOM/CDP nodes | Long tasks | Script | Task | Panes | Errors |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...results.map((result) =>
      `| ${result.id} | ${round(result.durationMs)} ms | ${round(result.jsHeapUsedMb)} MB | ${result.domElements}/${round(result.cdpNodes)} | ${result.longTaskCount} / ${round(result.longTaskMaxMs)} ms | ${round(result.cdpScriptDurationMs)} ms | ${round(result.cdpTaskDurationMs)} ms | ${result.dockviewPanes} | ${result.errors.length + result.failedRequests.length} |`,
    ),
    "",
    ...(composerResults.length > 0
      ? [
          "## Composer Typing",
          "",
          "| ID | Action | Inputs | Input to frame avg/max | Mutations | Key events |",
          "| --- | ---: | ---: | ---: | ---: | ---: |",
          ...composerResults.map((result) => {
            const typing = result.composerTyping;
            return `| ${result.id} | ${round(typing.actionMs)} ms | ${typing.inputEventCount} | ${round(typing.inputToFrameAvgMs)} / ${round(typing.inputToFrameMaxMs)} ms | ${typing.mutationBatchCount}/${typing.mutationCount} | ${typing.keydownCount}/${typing.keyupCount} |`;
          }),
          "",
        ]
      : []),
    ...(results.some((result) => result.liveDiagnostics)
      ? [
          "## Live Diagnostics",
          "",
          "| ID | Live events | Reducer batches/events | Reducer total/avg event | Refreshes | Delta misses | Patch bytes |",
          "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
          ...results.map((result) => {
            const live = result.liveDiagnostics;
            return `| ${result.id} | ${formatEventsByStream(live)} | ${formatReducerCounts(live)} | ${formatReducerDurations(live)} | ${live?.selectedThreadSnapshotRefreshes ?? ""} | ${live?.selectedThreadDeltaMisses ?? ""} | ${formatRecord(live?.patchBytesByScope)} |`;
          }),
          "",
        ]
      : []),
    "## Concerns",
    "",
    ...(concerns.length > 0 ? concerns.map((concern) => `- ${concern}`) : ["- No high-confidence performance blocker was detected in this run. Review traces for smaller hotspots."]),
    "",
    "## Agent-Browser Profiles",
    "",
    "| ID | Status | Trace | Screenshot |",
    "| --- | --- | --- | --- |",
    ...agentProfiles.map((profile) =>
      `| ${profile.id} | ${profile.ok ? "ok" : `failed: ${profile.error}`} | ${profile.tracePath ?? ""} | ${profile.screenshotPath ?? ""} |`,
    ),
    "",
    "## Artifacts",
    "",
    `- Machine-readable results: ${rel(path.join(OUT_DIR, "results.json"))}`,
    `- Playwright/CDP traces and screenshots: ${rel(OUT_DIR)}`,
    "",
  ];
  return `${lines.join("\n")}\n`;
}

function detectConcerns(results) {
  const concerns = [];
  const byId = Object.fromEntries(results.map((result) => [result.id, result]));
  for (const result of results) {
    if (result.errors.length > 0 || result.failedRequests.length > 0) {
      concerns.push(`${result.id}: console/request issues were captured (${result.errors.length} console/page, ${result.failedRequests.length} request).`);
    }
    if (result.longTaskMaxMs > 250) {
      concerns.push(`${result.id}: max long task ${round(result.longTaskMaxMs)} ms exceeds the 250 ms review threshold.`);
    } else if (result.longTaskMaxMs > 120) {
      concerns.push(`${result.id}: max long task ${round(result.longTaskMaxMs)} ms is noticeable and worth checking in the trace.`);
    }
    if (result.longTaskTotalMs > 1200) {
      concerns.push(`${result.id}: long-task total ${round(result.longTaskTotalMs)} ms suggests sustained main-thread pressure.`);
    }
    if (result.jsHeapUsedMb > 180) {
      concerns.push(`${result.id}: JS heap ${round(result.jsHeapUsedMb)} MB is high for this mocked dataset.`);
    }
  }
  if (byId["desktop-short-thread"] && byId["desktop-four-thread-panes"]) {
    const base = byId["desktop-short-thread"].cdpTaskDurationMs || 1;
    const multi = byId["desktop-four-thread-panes"].cdpTaskDurationMs || 0;
    if (multi / base > 4) {
      concerns.push(`desktop-four-thread-panes: task duration is ${round(multi / base)}x the single-thread baseline.`);
    }
  }
  if (byId["desktop-short-thread"] && byId["desktop-mixed-panes"]) {
    const base = byId["desktop-short-thread"].jsHeapUsedMb || 1;
    const mixed = byId["desktop-mixed-panes"].jsHeapUsedMb || 0;
    if (mixed / base > 3) {
      concerns.push(`desktop-mixed-panes: heap is ${round(mixed / base)}x the single-thread baseline.`);
    }
  }
  return concerns;
}

async function startProfileServer(port) {
  let activeScenario = "baseline";
  let terminalIndex = 0;
  const terminalSessions = new Map();
  const sseClients = new Set();

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
      if (request.method === "OPTIONS") {
        writeCors(response);
        response.writeHead(204).end();
        return;
      }
      if (url.pathname === "/__profile/scenario") {
        if (request.method === "POST") {
          const body = await readJson(request);
          activeScenario = typeof body.scenario === "string" ? body.scenario : "baseline";
          json(response, { scenario: activeScenario });
          return;
        }
        json(response, { scenario: activeScenario });
        return;
      }
      if (url.pathname === "/v1/events") {
        handleSse(request, response, activeScenario, sseClients);
        return;
      }
      if (url.pathname.startsWith("/v1/")) {
        await handleApi({
          activeScenario,
          request,
          response,
          terminalSessions,
          terminalIndexRef: {
            next() {
              terminalIndex += 1;
              return terminalIndex;
            },
          },
          url,
        });
        return;
      }
      await serveStatic(response, url.pathname);
    } catch (error) {
      console.error(error);
      json(response, { code: "mock_error", message: error instanceof Error ? error.message : String(error), retryable: false }, 500);
    }
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
    if (!url.pathname.match(/^\/v1\/terminals\/[^/]+\/ws$/)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      ws.send("Kodex mock terminal connected\r\n$ ");
      const timer = setInterval(() => {
        if (ws.readyState === ws.OPEN) {
          ws.send(`mock output ${new Date().toISOString()}\r\n$ `);
        }
      }, 1000);
      ws.on("message", () => {
        if (ws.readyState === ws.OPEN) {
          ws.send("ok\r\n$ ");
        }
      });
      ws.on("close", () => clearInterval(timer));
    });
  });

  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  return {
    close: async () => {
      for (const client of sseClients) {
        client.end();
      }
      await new Promise((resolve) => wss.close(resolve));
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function handleApi({ activeScenario, request, response, terminalSessions, terminalIndexRef, url }) {
  const key = `${request.method} ${url.pathname}`;
  if (key === "GET /v1/capabilities") {
    json(response, {
      gateway: {
        version: "0.1.0",
        sse: true,
        approvals: true,
        gatewayAuth: false,
        trustedNetworkOnly: true,
        terminals: { enabled: true },
      },
      appServer: { ready: true, experimentalApi: true },
    });
    return;
  }
  if (key === "GET /v1/projects") {
    json(response, { projects: [project] });
    return;
  }
  if (key === "GET /v1/threads") {
    const projectId = url.searchParams.get("projectId");
    json(response, {
      threads: projectId ? threadSummaries : [],
      nextCursor: null,
      backwardsCursor: null,
      rawPayload: {},
    });
    return;
  }
  if (key === "GET /v1/chats/threads") {
    json(response, { threads: [threadSummaries[0], threadSummaries[4], threadSummaries[5]], nextCursor: null, backwardsCursor: null, rawPayload: {} });
    return;
  }
  if (key === "GET /v1/threads/pinned") {
    json(response, { threads: [threadSummaries[1]], nextCursor: null, backwardsCursor: null, rawPayload: {} });
    return;
  }
  if (key === "GET /v1/sidebar/threads") {
    json(response, {
      projects: [project],
      chatThreads: { threads: [threadSummaries[0], threadSummaries[4], threadSummaries[5]], nextCursor: null, backwardsCursor: null, rawPayload: {} },
      pinnedThreads: { threads: [threadSummaries[1]], nextCursor: null, backwardsCursor: null, rawPayload: {} },
      projectThreads: {
        [project.id]: { threads: threadSummaries, nextCursor: null, backwardsCursor: null, rawPayload: {} },
      },
      rawPayload: {},
    });
    return;
  }
  const threadDetailMatch = url.pathname.match(/^\/v1\/threads\/([^/]+)$/);
  if (request.method === "GET" && threadDetailMatch) {
    const threadId = decodeURIComponent(threadDetailMatch[1]);
    const summary = threadSummaries.find((thread) => thread.id === threadId);
    if (!summary) {
      json(response, { code: "not_found", message: threadId, retryable: false }, 404);
      return;
    }
    json(response, threadDetailFor(summary, activeScenario));
    return;
  }
  const timelinePageMatch = url.pathname.match(/^\/v1\/threads\/([^/]+)\/timeline\/pages$/);
  if (request.method === "GET" && timelinePageMatch) {
    const threadId = decodeURIComponent(timelinePageMatch[1]);
    const summary = threadSummaries.find((thread) => thread.id === threadId) ?? threadSummaries[0];
    json(response, threadDetailFor(summary, activeScenario));
    return;
  }
  const subagentsMatch = url.pathname.match(/^\/v1\/threads\/([^/]+)\/subagents$/);
  if (request.method === "GET" && subagentsMatch) {
    json(response, { subagents: [] });
    return;
  }
  const queuedInputsMatch = url.pathname.match(/^\/v1\/threads\/([^/]+)\/queued-inputs$/);
  if (request.method === "GET" && queuedInputsMatch) {
    json(response, { queuedInputs: [] });
    return;
  }
  if (request.method === "POST" && queuedInputsMatch) {
    json(response, { queuedInput: queuedInput(decodeURIComponent(queuedInputsMatch[1])) });
    return;
  }
  const appSurfaceMatch = url.pathname.match(/^\/v1\/threads\/([^/]+)\/app-surface$/);
  if (request.method === "GET" && appSurfaceMatch) {
    const threadId = decodeURIComponent(appSurfaceMatch[1]);
    json(response, { session: appSurfaceSession(threadId) });
    return;
  }
  const appSurfaceDocumentMatch = url.pathname.match(/^\/v1\/app-surfaces\/([^/]+)\/document$/);
  if (request.method === "GET" && appSurfaceDocumentMatch) {
    html(response, appSurfaceDocument());
    return;
  }
  const appSurfaceBridgeMatch = url.pathname.match(/^\/v1\/app-surfaces\/([^/]+)\/bridge$/);
  if (request.method === "POST" && appSurfaceBridgeMatch) {
    json(response, {
      id: "bridge-result",
      result: { input: { disposition: "started", queuedInput: null, rawPayload: { turnId: "turn-bridge" } } },
    });
    return;
  }
  if (key === "GET /v1/approvals") {
    json(response, { approvals: activeScenario === "approvals" ? [approval()] : [] });
    return;
  }
  if (request.method === "POST" && url.pathname.startsWith("/v1/approvals/")) {
    json(response, { ...approval(), status: "resolved", response: { decision: "accept" } });
    return;
  }
  if (key === "GET /v1/account") {
    json(response, { requiresOpenaiAuth: true, account: null, rawPayload: {} });
    return;
  }
  if (key === "GET /v1/account/rate-limits") {
    json(response, { rateLimits: null, rateLimitsByLimitId: null, rawPayload: {} });
    return;
  }
  if (key === "GET /v1/models") {
    json(response, {
      models: [{
        id: "gpt-5.4",
        model: "gpt-5.4",
        displayName: "GPT-5.4",
        description: "General coding model",
        defaultReasoningEffort: "medium",
        hidden: false,
        inputModalities: ["text"],
        isDefault: true,
        rawPayload: {},
        supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Balanced" }],
        upgrade: null,
      }],
      nextCursor: null,
      rawPayload: {},
    });
    return;
  }
  if (key === "GET /v1/composer-settings") {
    json(response, { model: null, effort: null, serviceTier: null, permissionProfileId: null, permissionsPreset: null });
    return;
  }
  if (key === "PATCH /v1/composer-settings") {
    json(response, {});
    return;
  }
  if (key === "GET /v1/skills") {
    json(response, { skills: [], rawPayload: {} });
    return;
  }
  if (key === "GET /v1/permission-profiles") {
    json(response, { profiles: [{ id: ":workspace", label: ":workspace", description: null }], rawPayload: {} });
    return;
  }
  if (key === "GET /v1/automations") {
    json(response, { automations: [] });
    return;
  }
  if (key === "GET /v1/notifications/status") {
    json(response, { supported: false, permission: "default", subscription: null, rawPayload: {} });
    return;
  }
  if (key === "GET /v1/terminals") {
    json(response, { terminals: Array.from(terminalSessions.values()) });
    return;
  }
  if (key === "POST /v1/terminals") {
    const id = `terminal-${terminalIndexRef.next()}`;
    const terminal = {
      id,
      title: "Mock terminal",
      cwd: project.cwd,
      command: null,
      status: "running",
      createdAt: "2026-06-05T00:00:00Z",
      updatedAt: "2026-06-05T00:00:00Z",
    };
    terminalSessions.set(id, terminal);
    json(response, { terminal });
    return;
  }
  const terminalDeleteMatch = url.pathname.match(/^\/v1\/terminals\/([^/]+)$/);
  if (request.method === "DELETE" && terminalDeleteMatch) {
    terminalSessions.delete(decodeURIComponent(terminalDeleteMatch[1]));
    json(response, { id: decodeURIComponent(terminalDeleteMatch[1]) });
    return;
  }
  if (request.method === "POST" && url.pathname.match(/^\/v1\/threads\/[^/]+\/(attach|input|turns|seen|view-presence|interrupt-current)$/)) {
    json(response, { payload: {}, rawPayload: {} });
    return;
  }
  json(response, { code: "not_found", message: key, retryable: false }, 404);
}

function handleSse(request, response, activeScenario, clients) {
  writeCors(response);
  response.writeHead(200, {
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "Content-Type": "text/event-stream",
  });
  response.write(": connected\n\n");
  clients.add(response);
  let timer = null;
  if (activeScenario === "stream-heavy" || (request.url ?? "").includes("thread-stream")) {
    let index = 0;
    timer = setInterval(() => {
      if (index >= 120) {
        clearInterval(timer);
        return;
      }
      const event = itemDeltaEvent(index + 2, ` token-${index}`, "thread-stream", "turn-stream", "stream-agent");
      response.write(`event: thread_view.item_delta\ndata: ${JSON.stringify(event)}\n\n`);
      index += 1;
    }, 20);
  }
  request.on("close", () => {
    if (timer) {
      clearInterval(timer);
    }
    clients.delete(response);
  });
}

async function serveStatic(response, requestPath) {
  let resolvedPath = path.normalize(decodeURIComponent(requestPath)).replace(/^(\.\.[/\\])+/, "");
  if (resolvedPath === "/" || resolvedPath === ".") {
    resolvedPath = "/index.html";
  }
  let filePath = path.join(DIST_DIR, resolvedPath);
  try {
    const stats = await fs.stat(filePath);
    if (stats.isDirectory()) {
      filePath = path.join(filePath, "index.html");
    }
  } catch {
    filePath = path.join(DIST_DIR, "index.html");
  }
  const data = await fs.readFile(filePath);
  response.writeHead(200, { "Content-Type": mimeType(filePath) });
  response.end(data);
}

function threadDetailFor(summary, activeScenario) {
  const rowCount = summary.id === "thread-long" ? 640 : summary.id === "thread-stream" ? 24 : 36;
  const turns = summary.id === "thread-stream" ? streamTurns(summary.id) : turnsFor(summary.id, rowCount);
  return threadDetailBody(summary, turns, summary.status === "active" ? "streaming" : "idle", activeScenario);
}

function turnsFor(threadId, count) {
  const turns = [];
  for (let index = 0; index < count; index += 1) {
    const turnId = `turn-${index + 1}`;
    const itemId = `item-${index + 1}`;
    const selector = index % 10;
    let item;
    if (selector === 0) {
      item = {
        id: itemId,
        itemType: "userMessage",
        rawPayload: { id: itemId, type: "userMessage", text: `User request ${index + 1}: inspect pane performance.` },
      };
    } else if (selector === 3) {
      item = {
        id: itemId,
        itemType: "commandExecution",
        rawPayload: {
          id: itemId,
          type: "commandExecution",
          command: `cargo test profile_${index}`,
          output: `running profile_${index}\n${"0123456789abcdef".repeat(18)}\nfinished\n`,
        },
      };
    } else if (selector === 6) {
      item = {
        id: itemId,
        itemType: "fileChange",
        rawPayload: {
          id: itemId,
          type: "fileChange",
          changes: [{
            kind: "update",
            path: `apps/web/src/profile-${index}.tsx`,
            diff: `@@ -1 +1 @@\n-old ${index}\n+new ${index}\n`,
          }],
        },
      };
    } else {
      item = {
        id: itemId,
        itemType: "agentMessage",
        rawPayload: {
          id: itemId,
          type: "agentMessage",
          phase: selector === 9 ? "final_answer" : undefined,
          text: `Profile answer ${index + 1} for ${threadId}. ${"Timeline markdown content with enough text to wrap. ".repeat(3)}`,
        },
      };
    }
    turns.push({
      id: turnId,
      status: "completed",
      startedAt: 1777500000 + index,
      completedAt: 1777500001 + index,
      items: [item],
      rawPayload: {},
    });
  }
  return turns;
}

function streamTurns(threadId) {
  const base = turnsFor(threadId, 23);
  base.push({
    id: "turn-stream",
    status: "running",
    startedAt: 1777501000,
    items: [{
      id: "stream-agent",
      itemType: "agentMessage",
      rawPayload: { id: "stream-agent", type: "agentMessage", text: "Streaming seed" },
    }],
    rawPayload: {},
  });
  return base;
}

function threadDetailBody(sourceThread, turns = [], liveState = "idle") {
  return {
    thread: sourceThread,
    turns,
    liveState,
    timeline: timelineFromTurns(sourceThread, turns, liveState),
    rawPayload: {},
  };
}

function timelineFromTurns(sourceThread, turns, liveState) {
  let displayOrder = 0;
  const activeTurn = [...turns].reverse().find((turn) => !["completed", "failed", "cancelled"].includes(turn.status));
  const items = turns.flatMap((turn) =>
    turn.items.map((item) => {
      displayOrder += 1;
      return {
        id: `snapshot-${turn.id}-${item.id}`,
        threadId: String(sourceThread.id),
        turnId: turn.id,
        itemId: item.id,
        itemType: item.itemType,
        status: turn.status === "completed" ? "completed" : turn.status,
        displayOrder,
        codexMethod: turn.status === "completed" ? "item/completed" : "item/upsert",
        timestampMs: displayOrder,
        payload: {
          source: "appServerSnapshot",
          turnId: turn.id,
          itemId: item.id,
          item: item.rawPayload,
          itemSnapshot: item,
        },
      };
    }),
  );
  return {
    viewRevision: 1,
    activeTurnId: activeTurn?.id ?? null,
    liveState,
    rows: canonicalRowsFromSnapshotItems(items),
    items,
    pendingApprovalRequests: [],
    pendingUserInputRequests: [],
    turns: turns.map((turn) => ({ id: turn.id, status: turn.status, startedAt: turn.startedAt, completedAt: turn.completedAt })),
  };
}

function canonicalRowsFromSnapshotItems(items) {
  const rows = [];
  let activityItems = [];
  let fileItems = [];
  const flushActivity = () => {
    if (activityItems.length === 0) {
      return;
    }
    const first = activityItems[0];
    rows.push({
      id: `activity-${first.id}`,
      kind: "activity",
      turnId: first.turnId,
      displayOrder: first.displayOrder,
      status: first.status,
      timestampMs: first.timestampMs,
      item: null,
      items: activityItems,
      fileChanges: [],
      work: null,
      collapsedRows: [],
      dividerBefore: null,
    });
    activityItems = [];
  };
  const flushFiles = () => {
    if (fileItems.length === 0) {
      return;
    }
    const first = fileItems[0];
    rows.push({
      id: `file-changes-turn-${first.turnId}`,
      kind: "file_changes",
      turnId: first.turnId,
      displayOrder: first.displayOrder,
      status: first.status,
      timestampMs: first.timestampMs,
      item: null,
      items: [],
      fileChanges: fileItems.map(fileChangeEntryFromItem),
      work: null,
      collapsedRows: [],
      dividerBefore: null,
    });
    fileItems = [];
  };
  for (const item of [...items].sort((left, right) => left.displayOrder - right.displayOrder)) {
    const kind = canonicalKind(item.itemType);
    if (kind === "file_change") {
      flushActivity();
      fileItems.push(item);
      continue;
    }
    if (isActivityKind(kind)) {
      flushFiles();
      activityItems.push(item);
      continue;
    }
    flushActivity();
    flushFiles();
    rows.push(canonicalItemRow(item, kind));
  }
  flushActivity();
  flushFiles();
  return rows;
}

function canonicalItemRow(item, kind = canonicalKind(item.itemType)) {
  return {
    id: `item-${item.id}`,
    kind,
    turnId: item.turnId,
    displayOrder: item.displayOrder,
    status: item.status,
    timestampMs: item.timestampMs,
    item,
    items: [],
    fileChanges: [],
    work: null,
    collapsedRows: [],
    dividerBefore: null,
  };
}

function canonicalKind(itemType) {
  const normalized = itemType.toLowerCase().replace(/[_-]/g, "");
  const kinds = {
    agentmessage: "assistant_message",
    assistantmessage: "assistant_message",
    collabagenttoolcall: "collab_agent_tool_call",
    commandexecution: "command_execution",
    dynamictoolcall: "dynamic_tool_call",
    filechange: "file_change",
    imageview: "image_view",
    mcptoolcall: "mcp_tool_call",
    usermessage: "user_message",
    websearch: "web_search_group",
  };
  return kinds[normalized] ?? itemType;
}

function isActivityKind(kind) {
  return ["collab_agent_tool_call", "command_execution", "dynamic_tool_call", "image_view", "mcp_tool_call", "web_search_group"].includes(kind);
}

function fileChangeEntryFromItem(item) {
  const payload = item.payload.item && typeof item.payload.item === "object" ? item.payload.item : {};
  const changes = Array.isArray(payload.changes) ? payload.changes : [];
  const first = changes[0] && typeof changes[0] === "object" ? changes[0] : payload;
  const filePath = typeof first.path === "string" ? first.path : "unknown";
  const diff = typeof first.diff === "string" ? first.diff : "";
  return {
    id: `file-change-${item.id}`,
    path: filePath,
    action: "Modified",
    additions: diff.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++")).length,
    deletions: diff.split("\n").filter((line) => line.startsWith("-") && !line.startsWith("---")).length,
    diff,
    itemIds: [item.id],
  };
}

function itemDeltaEvent(seq, delta, threadId, turnId, itemId) {
  return {
    id: `item-delta-${seq}`,
    seq,
    kind: "thread_view.item_delta",
    codexMethod: "thread_view/item_delta",
    projectId: project.id,
    threadId,
    turnId,
    itemId,
    payload: {
      threadId,
      turnId,
      itemId,
      delta,
      viewRevision: seq,
    },
    receivedAt: "2026-06-05T00:00:02Z",
  };
}

function appSurfaceSession(threadId) {
  return {
    archivedAt: null,
    createdAt: "2026-06-05T00:00:00Z",
    csp: { connectDomains: [], resourceDomains: [] },
    displayModes: ["pane"],
    documentUrl: "/v1/app-surfaces/session-1/document?revision=1",
    fallbackContent: "Mockup chooser",
    grants: { canOpenLinks: false, canSendMessage: true, canUpdateModelContext: false, resources: [], tools: [] },
    bridgeToken: "bridge-token-1",
    id: "session-1",
    provenance: { source: "profile" },
    provider: "generated",
    resourceMimeType: "text/html",
    resourceUri: "ui://kodex/generated/session-1",
    revision: 1,
    status: "active",
    submitAvailable: true,
    submittedAt: null,
    submittedMessage: null,
    submittedMetadata: null,
    submittedRevision: null,
    threadId,
    title: "Performance mockup chooser",
    updatedAt: "2026-06-05T00:00:00Z",
  };
}

function appSurfaceDocument() {
  const cells = Array.from({ length: 80 }, (_, index) => `<button data-index="${index}">Option ${index}</button>`).join("");
  return `<!doctype html><html><head><style>
    body { margin: 0; font-family: system-ui; color: #e5e7eb; background: #111827; }
    main { padding: 16px; display: grid; gap: 12px; }
    .grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
    button { min-height: 38px; border: 1px solid #374151; border-radius: 6px; background: #1f2937; color: inherit; }
  </style></head><body><main>
    <h1>Performance mockup chooser</h1>
    <p>Generated UI frame with enough controls to exercise iframe layout.</p>
    <div class="grid">${cells}</div>
    <script>
      for (const button of document.querySelectorAll("button")) {
        button.addEventListener("click", () => {
          parent.postMessage({ jsonrpc: "2.0", id: "choice", method: "ui/message", sessionId: "session-1", revision: 1, params: { message: "Pick " + button.dataset.index } }, "*");
        });
      }
    </script>
  </main></body></html>`;
}

function approval() {
  return {
    id: "approval-1",
    requestId: "request-1",
    threadId: "thread-3",
    turnId: "turn-approval",
    itemId: "item-approval",
    method: "command_execution",
    status: "pending",
    payload: { command: "cargo test", cwd: project.cwd, reason: "Verify profile flow" },
    response: null,
    createdAt: "2026-06-05T00:00:00Z",
    resolvedAt: null,
  };
}

function queuedInput(threadId) {
  return {
    id: "queue-1",
    threadId,
    input: [{ type: "text", text: "Queued profile input" }],
    options: {},
    status: "queued",
    priority: "normal",
    attemptCount: 0,
    lastError: null,
    createdAt: "2026-06-05T00:00:00Z",
    updatedAt: "2026-06-05T00:00:00Z",
  };
}

function threadSummary(id, name, preview, status) {
  return {
    id,
    name,
    cwd: project.cwd,
    status,
    source: "local",
    preview,
    lastCompletedAgentTurnSeq: status === "active" ? 1 : 10,
    seenCompletedAgentTurnSeq: status === "active" ? 0 : 10,
    unreadCompletedAgentTurn: status === "active",
    rawPayload: {},
    createdAt: 1777500000,
    updatedAt: 1777501200,
  };
}

function workspaceState(panes, activePaneId) {
  return {
    activePaneId,
    dockviewLayout: null,
    panes,
    schemaVersion: 1,
  };
}

function threadPane(id, threadId, title) {
  return { id, kind: "thread", target: { mode: "existing", threadId }, title };
}

function generatedUiPane(id, threadId, title) {
  return { id, kind: "generatedUi", target: { mode: "latest", threadId }, title };
}

function terminalPane(id) {
  return { id, kind: "terminal", target: { command: null, cwd: project.cwd, terminalId: null }, title: "Terminal" };
}

async function expectText(page, text, timeout = 7000) {
  await page.getByText(text).first().waitFor({ state: "visible", timeout });
}

async function waitForPaneCount(page, count) {
  await page.waitForFunction((expected) => document.querySelectorAll(".kodex-workspace-pane-host").length >= expected, count);
}

async function waitForTimelineRows(page) {
  await page.waitForFunction(() => document.querySelectorAll(".kodex-timeline-virtual-row").length > 0, null, { timeout: 10000 });
}

async function clickDockTabs(page) {
  const tabs = page.locator(".dockview-tab, .dv-tab");
  const count = await tabs.count().catch(() => 0);
  for (let index = 0; index < Math.min(count, 4); index += 1) {
    await tabs.nth(index).click().catch(() => undefined);
    await page.waitForTimeout(80);
  }
}

async function scrollTimeline(page, delta) {
  const selector = ".kodex-thread-pane-scroll, .kodex-timeline-scroll";
  await page.evaluate(({ selector, delta }) => {
    const node = document.querySelector(selector);
    if (node) {
      node.scrollBy({ top: delta, behavior: "instant" });
    } else {
      window.scrollBy({ top: delta, behavior: "instant" });
    }
  }, { selector, delta });
}

async function settle(page) {
  await page.waitForTimeout(350);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function setServerScenario(baseUrl, scenario) {
  await fetch(`${baseUrl}/__profile/scenario`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scenario }),
  });
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function json(response, body, status = 200) {
  writeCors(response);
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

function html(response, body, status = 200) {
  writeCors(response);
  response.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  response.end(body);
}

function writeCors(response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Headers", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
}

function mimeType(filePath) {
  const ext = path.extname(filePath);
  return {
    ".css": "text/css",
    ".html": "text/html; charset=utf-8",
    ".ico": "image/x-icon",
    ".js": "text/javascript",
    ".json": "application/json",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".webmanifest": "application/manifest+json",
  }[ext] ?? "application/octet-stream";
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
    server.on("error", reject);
  });
}

async function runProcess(command, args, { cwd, env = process.env, quiet = false, timeoutMs = null } = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: quiet ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let stderr = "";
    let timedOut = false;
    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
          setTimeout(() => {
            if (!child.killed) {
              child.kill("SIGKILL");
            }
          }, 2000).unref();
        }, timeoutMs)
      : null;
    if (quiet) {
      child.stderr?.on("data", (chunk) => {
        stderr += chunk.toString();
      });
    }
    child.on("error", reject);
    child.on("exit", (code) => {
      if (timer) {
        clearTimeout(timer);
      }
      if (timedOut) {
        reject(new Error(`${command} ${args.join(" ")} timed out after ${timeoutMs} ms${stderr ? `: ${stderr}` : ""}`));
        return;
      }
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(" ")} exited ${code}${stderr ? `: ${stderr}` : ""}`));
      }
    });
  });
}

function bytesToMb(value) {
  return typeof value === "number" ? value / 1024 / 1024 : null;
}

function secondsToMs(value) {
  return typeof value === "number" ? value * 1000 : null;
}

function round(value) {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value * 10) / 10 : "";
}

function perCount(value, count) {
  return typeof value === "number" && Number.isFinite(value) && count > 0 ? value / count : null;
}

function formatEventsByStream(live) {
  if (!live) {
    return "";
  }
  return `g:${live.eventsByStream?.global ?? 0} s:${live.eventsByStream?.selected ?? 0}`;
}

function formatReducerCounts(live) {
  if (!live) {
    return "";
  }
  return `${live.reducerBatchCount}/${live.reducerEventCount}`;
}

function formatReducerDurations(live) {
  if (!live) {
    return "";
  }
  return `${round(live.reducerTotalDurationMs)} ms / ${round(perCount(live.reducerTotalDurationMs, live.reducerEventCount))} ms`;
}

function formatRecord(record) {
  if (!record || Object.keys(record).length === 0) {
    return "";
  }
  return Object.entries(record)
    .map(([key, value]) => `${key}:${round(value)}`)
    .join(", ");
}

function rel(filePath) {
  return path.relative(REPO_ROOT, filePath);
}

function unique(values) {
  return Array.from(new Set(values));
}

function formatOneLineResult(result) {
  const parts = [
    `  ${result.id}`,
    `${round(result.durationMs)}ms`,
    `heap=${round(result.jsHeapUsedMb)}MB`,
    `long=${result.longTaskCount}/${round(result.longTaskMaxMs)}ms`,
    `task=${round(result.cdpTaskDurationMs)}ms`,
    `panes=${result.dockviewPanes}`,
    `issues=${result.errors.length + result.failedRequests.length}`,
  ];
  if (result.composerTyping) {
    parts.splice(2, 0, `typing=${round(result.composerTyping.actionMs)}ms`);
    parts.splice(3, 0, `frame=${round(result.composerTyping.inputToFrameAvgMs)}/${round(result.composerTyping.inputToFrameMaxMs)}ms`);
  }
  if (result.liveDiagnostics?.reducerEventCount) {
    parts.splice(4, 0, `reduce=${round(result.liveDiagnostics.reducerTotalDurationMs)}ms/${result.liveDiagnostics.reducerEventCount}e`);
  }
  return parts.join(" ");
}
