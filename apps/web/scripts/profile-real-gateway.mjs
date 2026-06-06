#!/usr/bin/env node
import { chromium, devices } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(SCRIPT_DIR, "..");
const REPO_ROOT = path.resolve(WEB_DIR, "../..");
const OUT_ROOT = path.join(REPO_ROOT, "tmp", "real-gateway-profiling");
const RUN_ID = new Date().toISOString().replace(/[:.]/g, "-");
const OUT_DIR = path.join(OUT_ROOT, RUN_ID);
const cliOptions = parseCliOptions(process.argv.slice(2));
const BASE_URL = cliOptions.baseUrl;
const COMPOSER_TYPING_TEXT = "Real gateway prompt ".repeat(cliOptions.typingRepeat);
const TRACE_CATEGORIES = [
  "devtools.timeline",
  "v8.execute",
  "blink.user_timing",
  "latencyInfo",
  "renderer.scheduler",
  "toplevel",
].join(",");

await main();

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const threadTargets = await loadThreadTargets();
  const scenarios = buildScenarios(threadTargets);
  const results = [];

  for (const scenario of scenarios) {
    console.log(`\n[real-profile] ${scenario.id}`);
    results.push(await runScenario(scenario));
  }

  await writeReports({ results, threadTargets });
  console.log(`\nReal gateway profile complete: ${OUT_DIR}`);
}

async function loadThreadTargets() {
  const sidebar = await getJson("/v1/sidebar/threads");
  const projects = sidebar.projects ?? [];
  const kodexProject = projects.find((project) => project.cwd === REPO_ROOT)
    ?? projects.find((project) => project.name === "kodex")
    ?? projects[0]
    ?? null;
  const chatThreads = filterExcludedThreads(sidebar.chatThreads?.threads ?? []);
  const projectThreads = filterExcludedThreads(kodexProject ? sidebar.projectThreads?.[kodexProject.id]?.threads ?? [] : []);
  const idleProjectThreads = projectThreads.filter((thread) => thread.status !== "active");
  const primaryThread = idleProjectThreads[0] ?? projectThreads[0] ?? chatThreads[0] ?? null;
  const paneThreads = uniqueThreads([primaryThread, ...idleProjectThreads, ...projectThreads]).slice(0, 4);
  const generatedUiThread = [
    ...chatThreads,
    ...projectThreads,
  ].find((thread) => /generated ui|mcp.*ui|budget data/i.test(`${thread.name ?? ""} ${thread.preview ?? ""}`)) ?? null;

  if (!primaryThread || paneThreads.length === 0) {
    throw new Error("Could not find real gateway threads to profile.");
  }

  return {
    generatedUiThread,
    kodexProject,
    paneThreads,
    primaryThread,
  };
}

function buildScenarios(targets) {
  const primary = targets.primaryThread;
  const secondary = targets.paneThreads[1] ?? primary;
  const panes = targets.paneThreads;
  const scenarios = [
    {
      id: "real-desktop-two-pane-load",
      label: "Real desktop two-pane load",
      path: `/threads/${primary.id}`,
      seedWorkspace: workspaceState([
        threadPane("pane-real-1", primary.id, primary.name ?? "Primary thread"),
        threadPane("pane-real-2", secondary.id, secondary.name ?? "Secondary thread"),
      ], "pane-real-1"),
      viewport: { width: 1440, height: 900 },
      action: async ({ page }) => {
        await waitForPaneCount(page, 2);
        await waitForAnyThreadContent(page);
        await page.waitForTimeout(1500);
      },
    },
    {
      id: "real-desktop-four-pane-load",
      label: "Real desktop four-pane load",
      path: `/threads/${primary.id}`,
      seedWorkspace: workspaceState(panes.map((thread, index) =>
        threadPane(`pane-real-${index + 1}`, thread.id, thread.name ?? `Thread ${index + 1}`),
      ), "pane-real-1"),
      viewport: { width: 1600, height: 940 },
      action: async ({ page }) => {
        await waitForPaneCount(page, Math.min(panes.length, 4));
        await waitForAnyThreadContent(page);
        await page.waitForTimeout(1800);
      },
    },
    {
      id: "real-desktop-composer-typing",
      label: "Real desktop composer typing, two panes",
      path: `/threads/${primary.id}`,
      seedWorkspace: workspaceState([
        threadPane("pane-real-1", primary.id, primary.name ?? "Primary thread"),
        threadPane("pane-real-2", secondary.id, secondary.name ?? "Secondary thread"),
      ], "pane-real-1"),
      viewport: { width: 1440, height: 900 },
      action: async ({ page }) => {
        await waitForAnyThreadContent(page);
        await profileComposerTyping(page, COMPOSER_TYPING_TEXT);
      },
    },
    {
      id: "real-mobile-composer-typing",
      label: "Real mobile composer typing",
      mobile: true,
      path: `/threads/${primary.id}`,
      viewport: { width: 390, height: 844 },
      action: async ({ page }) => {
        await waitForAnyThreadContent(page);
        await profileComposerTyping(page, COMPOSER_TYPING_TEXT, { expandMobileComposer: true });
      },
    },
    {
      id: "real-desktop-stream-smoke",
      label: "Real desktop streaming smoke task",
      path: "/",
      viewport: { width: 1440, height: 900 },
      action: async ({ page }) => {
        await page.getByLabel(/message composer/i).last().waitFor({ state: "visible", timeout: 15000 });
        await profileStreamingSubmission(page);
      },
    },
    {
      id: "real-desktop-stream-two-pane",
      label: "Real desktop streaming smoke task, two panes",
      path: "/",
      seedWorkspace: workspaceState([
        draftThreadPane("pane-real-draft", targets.kodexProject?.id ?? null, "Draft Thread"),
        threadPane("pane-real-context", primary.id, primary.name ?? "Primary thread"),
      ], "pane-real-draft"),
      viewport: { width: 1440, height: 900 },
      action: async ({ page }) => {
        await waitForPaneCount(page, 2);
        await page.getByLabel(/message composer/i).last().waitFor({ state: "visible", timeout: 15000 });
        await profileStreamingSubmission(page);
      },
    },
  ];

  if (targets.generatedUiThread) {
    scenarios.push({
      id: "real-generated-ui-toggle",
      label: "Real generated UI toggle",
      path: `/threads/${targets.generatedUiThread.id}`,
      viewport: { width: 1440, height: 900 },
      action: async ({ page }) => {
        await waitForAnyThreadContent(page);
        const showButton = page.getByRole("button", { name: /show app surface|open generated ui/i }).first();
        await showButton.click({ timeout: 10000 });
        await page.locator(".kodex-generated-ui-pane iframe").first().waitFor({ state: "visible", timeout: 10000 });
        await page.waitForTimeout(1000);
      },
    });
  }

  return cliOptions.only.length === 0
    ? scenarios
    : scenarios.filter((scenario) => cliOptions.only.includes(scenario.id));
}

async function runScenario(scenario) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext(contextOptions(scenario));
  await installPerfObserver(context, scenario.seedWorkspace);
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
  page.on("requestfailed", (request) =>
    failedRequests.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? ""}`),
  );
  page.on("response", (response) => {
    if (response.status() >= 400) {
      failedRequests.push(`${response.status()} ${response.request().method()} ${response.url()}`);
    }
  });

  await client.send("Performance.enable").catch(() => undefined);
  if (cliOptions.cpuThrottleRate !== 1) {
    await client.send("Emulation.setCPUThrottlingRate", { rate: cliOptions.cpuThrottleRate }).catch(() => undefined);
  }
  const tracePath = path.join(OUT_DIR, `${scenario.id}.trace.json`);
  const screenshotPath = path.join(OUT_DIR, `${scenario.id}.png`);
  const startedAt = Date.now();

  try {
    await startChromeTrace(client);
    await page.goto(`${BASE_URL}${scenario.path}`, { waitUntil: "domcontentloaded" });
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
    await page.getByRole("dialog", { name: /compose/i }).waitFor({ state: "visible", timeout: 10000 });
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

async function profileStreamingSubmission(page) {
  await page.evaluate(() => {
    window.__kodexProfile.streaming = {
      startedAt: performance.now(),
      timelineMutations: 0,
    };
    const timeline = document.querySelector(".kodex-timeline, .kodex-thread-scroll, main") ?? document.body;
    new MutationObserver((records) => {
      window.__kodexProfile.streaming.timelineMutations += records.length;
    }).observe(timeline, { attributes: true, childList: true, characterData: true, subtree: true });
  });
  const composer = page.getByLabel(/message composer/i).last();
  await composer.click();
  await page.keyboard.type(
    "Performance profiling smoke test. Please respond with 50 short numbered lines. Do not inspect files, modify files, or run shell commands.",
    { delay: 1 },
  );
  await page.getByRole("button", { name: /send message/i }).last().click();
  await page.waitForTimeout(cliOptions.streamWaitMs);
  await page.evaluate(() => {
    window.__kodexProfile.streaming.finishedAt = performance.now();
  });
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
    const streaming = profile.streaming ?? null;
    const streamingActionMs = streaming?.finishedAt && streaming?.startedAt
      ? streaming.finishedAt - streaming.startedAt
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
      streaming: streaming
        ? {
            actionMs: streamingActionMs,
            timelineMutations: streaming.timelineMutations,
          }
        : null,
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

async function installPerfObserver(context, seedWorkspace) {
  await context.addInitScript(({ seed }) => {
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
      // Layout shift is advisory for this profiling run.
    }
    if (window === window.top) {
      try {
        window.localStorage.clear();
        if (seed) {
          window.localStorage.setItem("kodex.workspace.panes.v1", JSON.stringify(seed));
        }
      } catch {
        // Storage is best-effort profile setup; sandboxed iframes can reject access.
      }
    }
  }, { seed: seedWorkspace ?? null });
}

async function writeReports({ results, threadTargets }) {
  const jsonPath = path.join(OUT_DIR, "results.json");
  const reportPath = path.join(OUT_DIR, "report.md");
  const payload = {
    baseUrl: BASE_URL,
    generatedAt: new Date().toISOString(),
    results,
    threadTargets: summarizeTargets(threadTargets),
  };
  await fs.writeFile(jsonPath, `${JSON.stringify(payload, null, 2)}\n`);
  await fs.writeFile(reportPath, renderReport(payload));
}

function renderReport({ baseUrl, generatedAt, results, threadTargets }) {
  const composerResults = results.filter((result) => result.composerTyping);
  const streamingResults = results.filter((result) => result.streaming);
  const lines = [
    "# Real Gateway Profiling Report",
    "",
    `Generated: ${generatedAt}`,
    `Target: ${baseUrl}`,
    `Kodex project: ${threadTargets.kodexProjectName ?? "(unknown)"}`,
    `Primary thread: ${threadTargets.primaryThreadName ?? "(unnamed)"} (${threadTargets.primaryThreadId})`,
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
    ...(streamingResults.length > 0
      ? [
          "## Streaming",
          "",
          "| ID | Observation window | Timeline mutations | Reducer | Task/mutation | Script/mutation | Long tasks | Task | Script |",
          "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
          ...streamingResults.map((result) => {
            const streaming = result.streaming;
            const live = result.liveDiagnostics;
            return `| ${result.id} | ${round(streaming.actionMs)} ms | ${streaming.timelineMutations} | ${formatReducerSummary(live)} | ${round(perCount(result.cdpTaskDurationMs, streaming.timelineMutations))} ms | ${round(perCount(result.cdpScriptDurationMs, streaming.timelineMutations))} ms | ${result.longTaskCount} / ${round(result.longTaskMaxMs)} ms | ${round(result.cdpTaskDurationMs)} ms | ${round(result.cdpScriptDurationMs)} ms |`;
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
    "## Issues",
    "",
    ...issueLines(results),
    "",
    "## Artifacts",
    "",
    `- Machine-readable results: ${rel(path.join(OUT_DIR, "results.json"))}`,
    `- Traces and screenshots: ${rel(OUT_DIR)}`,
    "",
  ];
  return `${lines.join("\n")}\n`;
}

function issueLines(results) {
  const lines = [];
  for (const result of results) {
    for (const error of result.errors) {
      lines.push(`- ${result.id}: ${error}`);
    }
    for (const request of result.failedRequests) {
      lines.push(`- ${result.id}: ${request}`);
    }
  }
  return lines.length > 0 ? lines : ["- No console, page, or request issues captured."];
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

async function waitForAnyThreadContent(page) {
  await page.waitForFunction(() =>
    document.querySelectorAll(".kodex-timeline-virtual-row").length > 0 ||
    document.querySelectorAll('[aria-label="Message composer"]').length > 0 ||
    document.body.innerText.length > 500,
  { timeout: 20000 });
}

async function waitForPaneCount(page, count) {
  await page.waitForFunction(
    (expected) => document.querySelectorAll(".kodex-workspace-pane-host").length >= expected,
    count,
    { timeout: 20000 },
  );
}

async function settle(page) {
  await page.waitForTimeout(500);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

function contextOptions(scenario) {
  if (!scenario.mobile) {
    return {
      colorScheme: "dark",
      deviceScaleFactor: 1,
      viewport: scenario.viewport,
    };
  }
  return {
    ...devices["iPhone 14"],
    colorScheme: "dark",
    viewport: scenario.viewport,
  };
}

async function getJson(pathname) {
  const response = await fetch(`${BASE_URL}${pathname}`);
  if (!response.ok) {
    throw new Error(`GET ${pathname} failed: ${response.status}`);
  }
  return response.json();
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
  return {
    id,
    kind: "thread",
    target: { mode: "existing", threadId },
    title,
  };
}

function draftThreadPane(id, projectId, title) {
  return {
    id,
    kind: "thread",
    target: { mode: "draft", projectId },
    title,
  };
}

function uniqueThreads(threads) {
  const byId = new Map();
  for (const thread of threads) {
    if (thread?.id && !byId.has(thread.id)) {
      byId.set(thread.id, thread);
    }
  }
  return [...byId.values()];
}

function summarizeTargets(targets) {
  return {
    generatedUiThreadId: targets.generatedUiThread?.id ?? null,
    generatedUiThreadName: targets.generatedUiThread?.name ?? null,
    kodexProjectId: targets.kodexProject?.id ?? null,
    kodexProjectName: targets.kodexProject?.name ?? null,
    paneThreads: targets.paneThreads.map((thread) => ({ id: thread.id, name: thread.name, status: thread.status })),
    primaryThreadId: targets.primaryThread.id,
    primaryThreadName: targets.primaryThread.name,
  };
}

function parseCliOptions(args) {
  const options = {
    baseUrl: "http://127.0.0.1:8787",
    cpuThrottleRate: 1,
    excludeThreadPattern: null,
    only: [],
    streamWaitMs: 12000,
    typingDelayMs: 1,
    typingRepeat: 36,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--base-url") {
      options.baseUrl = args[index + 1] ?? options.baseUrl;
      index += 1;
      continue;
    }
    if (arg.startsWith("--base-url=")) {
      options.baseUrl = arg.slice("--base-url=".length);
      continue;
    }
    if (arg === "--cpu-throttle") {
      options.cpuThrottleRate = positiveNumberOption(args[index + 1], "--cpu-throttle");
      index += 1;
      continue;
    }
    if (arg.startsWith("--cpu-throttle=")) {
      options.cpuThrottleRate = positiveNumberOption(arg.slice("--cpu-throttle=".length), "--cpu-throttle");
      continue;
    }
    if (arg === "--exclude-thread-pattern") {
      options.excludeThreadPattern = args[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg.startsWith("--exclude-thread-pattern=")) {
      options.excludeThreadPattern = arg.slice("--exclude-thread-pattern=".length);
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
    if (arg === "--stream-wait") {
      options.streamWaitMs = numberOption(args[index + 1], "--stream-wait");
      index += 1;
      continue;
    }
    if (arg.startsWith("--stream-wait=")) {
      options.streamWaitMs = numberOption(arg.slice("--stream-wait=".length), "--stream-wait");
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
    throw new Error(`Unknown real profile option: ${arg}`);
  }
  return options;
}

function filterExcludedThreads(threads) {
  if (!cliOptions.excludeThreadPattern) {
    return threads;
  }
  const excludePattern = new RegExp(cliOptions.excludeThreadPattern, "i");
  return threads.filter((thread) => {
    const searchableText = `${thread.id ?? ""} ${thread.name ?? ""} ${thread.preview ?? ""}`;
    return !excludePattern.test(searchableText);
  });
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

function positiveNumberOption(value, name) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`${name} must be a number greater than or equal to 1.`);
  }
  return parsed;
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

function formatReducerSummary(live) {
  if (!live) {
    return "";
  }
  return `${round(live.reducerTotalDurationMs)} ms (${live.reducerBatchCount}/${live.reducerEventCount})`;
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
  if (result.streaming) {
    parts.splice(2, 0, `stream=${round(result.streaming.actionMs)}ms`);
    parts.splice(3, 0, `mut=${result.streaming.timelineMutations}`);
  }
  if (result.liveDiagnostics?.reducerEventCount) {
    parts.splice(4, 0, `reduce=${round(result.liveDiagnostics.reducerTotalDurationMs)}ms/${result.liveDiagnostics.reducerEventCount}e`);
  }
  return parts.join(" ");
}
