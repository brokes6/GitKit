import ts from "typescript";
import { readFileSync, writeFileSync } from "node:fs";

const catalog = new Set();

function visit(node) {
  if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isJsxText(node))
      && /[\u3400-\u9fff]/.test(node.text)) {
    catalog.add(node.text.trim().replace(/\s+/g, " "));
  }
  ts.forEachChild(node, visit);
}

for (const file of ["App.tsx", "dailyCheck.ts", "gitlabToken.ts", "githubToken.ts", "git.ts"]) {
  const path = new URL(`../src/${file}`, import.meta.url);
  const source = ts.createSourceFile(file, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  visit(source);
}
writeFileSync(new URL("../src/i18n-catalog.json", import.meta.url),
  JSON.stringify([...catalog].sort((a, b) => a.localeCompare(b, "zh")), null, 2) + "\n");
