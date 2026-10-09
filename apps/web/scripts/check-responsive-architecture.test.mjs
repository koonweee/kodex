import assert from "node:assert/strict";
import { test } from "node:test";
import { auditResponsiveSource, auditPaneCss } from "./check-responsive-architecture.mjs";

const audit = (source, file = "src/composer/Example.tsx") => auditResponsiveSource(source, file);

test("reports literal and identifier viewport queries with source locations", () => {
  const findings = audit(`const QUERY = "(max-width: 700px)";
window.matchMedia(QUERY);
matchMedia("(width < 500px)");`);
  assert.deepEqual(findings.map(({ line }) => line), [2, 3]);
});

test("catches named aliases and namespace Mantine media hooks", () => {
  const findings = audit(`import { useMediaQuery as useFit } from "@mantine/hooks";
import * as hooks from "@mantine/hooks";
useFit("(max-width: 700px)");
hooks.useMediaQuery("(any-pointer: coarse)");`);
  assert.equal(findings.length, 2);
});

test("unknown imported or computed queries cannot bypass ownership", () => {
  assert.equal(audit(`import { QUERY } from "./local"; window.matchMedia(QUERY);`).length, 1);
  assert.equal(audit(`window.matchMedia(makeQuery());`).length, 1);
});

test("same query identifier in different scopes cannot mask responsive detection", () => {
  const findings = audit(`function layout() {
  const QUERY = "(max-width: 700px)";
  window.matchMedia(QUERY);
}
function appearance() {
  const QUERY = "(prefers-reduced-motion: reduce)";
  window.matchMedia(QUERY);
}`);
  assert.deepEqual(findings.map(({ line }) => line), [3]);
});

test("parameters and mutable queries cannot borrow a constant's appearance exemption", () => {
  const findings = audit(`const QUERY = "(prefers-color-scheme: dark)";
function layout(QUERY) { window.matchMedia(QUERY); }
let CHANGEABLE = "(prefers-color-scheme: dark)";
CHANGEABLE = "(max-width: 700px)";
window.matchMedia(CHANGEABLE);`);
  assert.deepEqual(findings.map(({ line }) => line), [2, 5]);
});

test("function-hoisted mutable bindings cannot borrow an outer appearance exemption", () => {
  const findings = audit(`const QUERY = "(prefers-color-scheme: dark)";
function layout() {
  if (enabled) { var QUERY = "(max-width: 700px)"; }
  window.matchMedia(QUERY);
}`);
  assert.deepEqual(findings.map(({ line }) => line), [4]);
});

test("direct navigator access includes bracket notation", () => {
  assert.equal(audit(`navigator.maxTouchPoints; window.navigator["maxTouchPoints"];`).length, 2);
});

test("appearance/accessibility queries, actual events and placement remain allowed", () => {
  assert.deepEqual(audit(`const REDUCED = "(prefers-reduced-motion: reduce)";
window.matchMedia(REDUCED);
window.matchMedia("(prefers-color-scheme: dark)");
const touch = event.pointerType === "touch";
const right = rect.left + window.innerWidth;
const keyboard = window.visualViewport?.height;`), []);
});

test("shared fact owners can detect facts but similarly named feature files cannot", () => {
  const source = `navigator.maxTouchPoints; window.matchMedia("(pointer: coarse)");`;
  for (const file of ["src/shared/inputCapabilities.ts", "src/shared/layoutBreakpoints.ts", "src/shared/PaneLayout.tsx"]) {
    assert.deepEqual(audit(source, file), []);
  }
  assert.equal(audit(source, "src/composer/inputCapabilities.ts").length, 2);
});

test("tests and generated contracts are excluded, production declarations are checked", () => {
  assert.deepEqual(audit(`navigator.maxTouchPoints;`, "src/shared/example.test.ts"), []);
  assert.deepEqual(audit(`navigator.maxTouchPoints;`, "src/test/setup.ts"), []);
  assert.deepEqual(audit(`navigator.maxTouchPoints;`, "src/api/generated/schema.ts"), []);
  assert.equal(audit(`navigator.maxTouchPoints;`, "src/composer/example.ts").length, 1);
});

test("pane CSS rejects viewport fit while allowing input, appearance and container queries", () => {
  const css = `@media (max-width: 640px) { .example { display: none; } }
@media (pointer: coarse) { .example { padding: 1em; } }
@container pane (width < 640px) { .example { display: none; } }`;
  const findings = auditPaneCss(css, "src/styles/timeline-messages.css");
  assert.equal(findings.length, 1);
  assert.equal(findings[0].line, 1);
  assert.deepEqual(auditPaneCss(css, "src/styles/shell.css"), []);
});
