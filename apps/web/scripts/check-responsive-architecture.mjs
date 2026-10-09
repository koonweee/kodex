import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const sharedOwners = new Set([
  "src/shared/inputCapabilities.ts",
  "src/shared/layoutBreakpoints.ts",
  "src/shared/PaneLayout.tsx",
]);

// These surfaces belong to a pane. Shell/sidebar/global overlay styles retain
// viewport-fit rules; mixed style files are reviewed at their owning surface.
const paneStyleOwners = new Set([
  "src/styles/composer.css",
  "src/styles/mobile-composer.css",
  "src/styles/timeline-messages.css",
  "src/timeline/asyncQuestions.css",
  "src/goals/goals.css",
]);
const responsiveFeature = /\(\s*(?:(?:min|max)-)?(?:width|height|inline-size|block-size|pointer|any-pointer|hover|any-hover|orientation)\b/i;

function isExcluded(file) {
  return /(?:^|\/)(?:test|__tests__|generated)\//.test(file) || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file);
}

function propertyName(node) {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) && node.argumentExpression && ts.isStringLiteralLike(node.argumentExpression)) {
    return node.argumentExpression.text;
  }
  return undefined;
}

export function auditResponsiveSource(source, file) {
  if (sharedOwners.has(file) || isExcluded(file)) return [];
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const mediaHooks = new Set();
  const mantineNamespaces = new Set();
  const bindingsByScope = new Map();
  const findings = [];
  function recordBinding(node, name, initializer, functionScoped = false) {
    if (!ts.isIdentifier(name)) {
      for (const element of name.elements) {
        if (ts.isBindingElement(element)) recordBinding(node, element.name, undefined, functionScoped);
      }
      return;
    }
    let scope = node.parent;
    while (scope && !ts.isSourceFile(scope) && (functionScoped || !ts.isBlock(scope)) && !ts.isFunctionLike(scope)) scope = scope.parent;
    let bindings = bindingsByScope.get(scope);
    if (!bindings) bindingsByScope.set(scope, bindings = new Map());
    // Duplicate declarations are uncertain rather than whichever appeared last.
    bindings.set(name.text, bindings.has(name.text) ? undefined : initializer);
  }
  function resolveBinding(node) {
    for (let scope = node.parent; scope; scope = scope.parent) {
      const bindings = bindingsByScope.get(scope);
      if (bindings?.has(node.text)) return bindings.get(node.text);
    }
    return undefined;
  }
  function collect(node) {
    if (ts.isImportDeclaration(node) && node.moduleSpecifier.text === "@mantine/hooks") {
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const entry of bindings.elements) {
          if ((entry.propertyName ?? entry.name).text === "useMediaQuery") mediaHooks.add(entry.name.text);
        }
      } else if (bindings && ts.isNamespaceImport(bindings)) {
        mantineNamespaces.add(bindings.name.text);
      }
    }
    if (ts.isVariableDeclaration(node)) {
      const flags = ts.isVariableDeclarationList(node.parent) ? node.parent.flags : 0;
      recordBinding(node, node.name, flags & ts.NodeFlags.Const ? node.initializer : undefined,
        !(flags & (ts.NodeFlags.Const | ts.NodeFlags.Let)));
    } else if (ts.isParameter(node)) {
      recordBinding(node, node.name, undefined);
    }
    ts.forEachChild(node, collect);
  }
  collect(tree);
  function queryText(node, seen = new Set()) {
    if (!node) return undefined;
    if (ts.isStringLiteralLike(node)) return node.text;
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
      return queryText(node.expression, seen);
    }
    if (ts.isIdentifier(node) && !seen.has(node)) {
      seen.add(node);
      return queryText(resolveBinding(node), seen);
    }
    return undefined;
  }
  function report(node, message) {
    const { line } = tree.getLineAndCharacterOfPosition(node.getStart(tree));
    findings.push({ file, line: line + 1, message });
  }
  function visit(node) {
    if (propertyName(node) === "maxTouchPoints") {
      report(node, "Read touch availability through shared/inputCapabilities.ts.");
    }
    if (ts.isCallExpression(node)) {
      const name = ts.isIdentifier(node.expression) ? node.expression.text : propertyName(node.expression);
      const isMantineHook = ts.isIdentifier(node.expression)
        ? mediaHooks.has(name)
        : name === "useMediaQuery" && ts.isPropertyAccessExpression(node.expression)
          && ts.isIdentifier(node.expression.expression) && mantineNamespaces.has(node.expression.expression.text);
      if (name === "matchMedia" || isMantineHook) {
        const query = queryText(node.arguments[0]);
        if (query === undefined || responsiveFeature.test(query)) {
          report(node, "Read responsive facts through shared layout/input owners; consume pane classifications for pane fit.");
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return findings;
}

export function auditPaneCss(source, file) {
  if (!paneStyleOwners.has(file)) return [];
  // Match only at-rule headers, ignoring comments. This audits ownership rather
  // than CSS declarations; rendered layout belongs in browser acceptance tests.
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
  return [...withoutComments.matchAll(/@media\s+([^{}]+)\{/g)].flatMap((match) => {
    if (!/\(\s*(?:(?:min|max)-)?(?:width|height|inline-size|block-size)\b/i.test(match[1])) return [];
    return [{
      file,
      line: withoutComments.slice(0, match.index).split("\n").length,
      message: "Pane fit must use its pane classification/container, not a viewport media query.",
    }];
  });
}

function sourceFiles(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(root, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : /\.(?:[jt]sx?|css)$/.test(entry.name) ? [path] : [];
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const findings = sourceFiles(resolve(webRoot, "src")).flatMap((path) => {
    const file = relative(webRoot, path).replaceAll("\\", "/");
    const source = readFileSync(path, "utf8");
    return file.endsWith(".css") ? auditPaneCss(source, file) : auditResponsiveSource(source, file);
  });
  for (const finding of findings) console.error(`${finding.file}:${finding.line}: ${finding.message}`);
  if (findings.length) process.exitCode = 1;
  else console.log("Responsive architecture check passed.");
}
