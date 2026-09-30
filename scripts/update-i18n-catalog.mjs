import ts from "typescript";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

function sourceFiles(directory, extension) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = new URL(entry.name + (entry.isDirectory() ? "/" : ""), directory);
    return entry.isDirectory() ? sourceFiles(path, extension) : extension.test(entry.name) ? [path] : [];
  });
}

export function collectNativeSources() {
  const sources = new Set();
  for (const path of sourceFiles(new URL("../src-tauri/src/", import.meta.url), /\.rs$/)) {
    if (path.pathname.endsWith("_tests.rs")) continue;
    const source = readFileSync(path, "utf8");
    const testStarts = new Set([...source.matchAll(/#\[cfg\(test\)\]\s*mod\s+\w+\s*\{/g)]
      .map((match) => match.index + match[0].length - 1));
    let testDepth = 0;
    // Skip comments and test modules before collecting Rust string literals.
    for (const match of source.matchAll(/\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])'|[{}]/g)) {
      const token = match[0];
      if (testStarts.has(match.index)) { testDepth = 1; continue; }
      if (testDepth) {
        if (token === "{") testDepth++;
        if (token === "}") testDepth--;
        continue;
      }
      if (!token.startsWith('"') || !/[\u3400-\u9fff]/.test(token)) continue;
      let index = 0;
      sources.add(JSON.parse(token).replace(/\{(?:[A-Za-z_][A-Za-z_\d]*)?\}/g, () => `{${index++}}`));
    }
  }
  return [...sources];
}

export function collectCatalog() {
  const catalog = new Set(collectNativeSources());
  function visit(node) {
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isJsxText(node))
        && /[\u3400-\u9fff]/.test(node.text)) {
      catalog.add(node.text.trim().replace(/\s+/g, " "));
    }
    ts.forEachChild(node, visit);
  }
  for (const path of sourceFiles(new URL("../src/", import.meta.url), /\.tsx?$/)) {
    if (path.pathname.endsWith("/i18n.ts")) continue;
    const source = ts.createSourceFile(path.pathname, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true,
      path.pathname.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    visit(source);
  }
  return [...catalog].sort((a, b) => a.localeCompare(b, "zh"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  writeFileSync(new URL("../src/i18n-catalog.json", import.meta.url), JSON.stringify(collectCatalog(), null, 2) + "\n");
}
