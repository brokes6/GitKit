import { createHighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { DIFF_LANGUAGES, grammarIdForDiffLanguage, languageForDiffPath } from "./diffLanguages";
import type { DiffLanguage } from "./diffLanguages";
import { compactSyntaxTokens } from "./diffSyntaxTokens";
import type { SyntaxToken } from "./diffSyntaxTokens";

type DiffKind = "add" | "del" | "ctx" | "hunk" | "meta";
type DiffLine = { kind: DiffKind; text: string };
type SyntaxPalette = {
  name: string; dark: boolean; text: string; muted: string;
  keyword: string; string: string; number: string; function: string; type: string;
};
type Token = SyntaxToken;

const highlighterPromise = createHighlighterCore({
  themes: [], langs: [], engine: createJavaScriptRegexEngine(),
});
const languageLoads = new Map<DiffLanguage, Promise<void>>();
const themeLoads = new Map<string, Promise<void>>();
const cancelled = new Set<number>();

async function ensureLanguage(language: DiffLanguage) {
  let load = languageLoads.get(language);
  if (!load) {
    load = highlighterPromise.then(async (highlighter) => {
      await highlighter.loadLanguage((await DIFF_LANGUAGES[language]()).default);
    });
    languageLoads.set(language, load);
  }
  await load;
}

async function ensureTheme(palette: SyntaxPalette) {
  let load = themeLoads.get(palette.name);
  if (!load) {
    load = highlighterPromise.then((highlighter) => highlighter.loadTheme(themeFor(palette)));
    themeLoads.set(palette.name, load);
  }
  await load;
}


function themeFor(p: SyntaxPalette) {
  return {
    name: p.name,
    type: p.dark ? "dark" as const : "light" as const,
    colors: { "editor.foreground": p.text },
    settings: [
      { settings: { foreground: p.text } },
      { scope: ["comment", "punctuation.definition.comment"], settings: { foreground: p.muted } },
      { scope: ["string", "string.quoted", "string.template"], settings: { foreground: p.string } },
      { scope: ["constant.numeric", "constant.language", "constant.character"], settings: { foreground: p.number } },
      { scope: ["keyword", "storage", "storage.type"], settings: { foreground: p.keyword } },
      { scope: ["entity.name.function", "support.function"], settings: { foreground: p.function } },
      { scope: ["entity.name.type", "entity.name.class", "support.class", "support.type"], settings: { foreground: p.type } },
    ],
  };
}

async function tokenizeRows(rows: DiffLine[], lang: string, theme: string, baseColor: string, id: number,
  highlighter: Awaited<typeof highlighterPromise>): Promise<Token[][] | null> {
  const result: Token[][] = Array.from({ length: rows.length }, () => []);
  let start = 0;
  while (start < rows.length) {
    if (cancelled.has(id)) return null;
    if (rows[start].kind === "hunk" || rows[start].kind === "meta") { start++; continue; }
    let end = start;
    while (end < rows.length && rows[end].kind !== "hunk" && rows[end].kind !== "meta") end++;
    for (const side of ["old", "new"] as const) {
      if (cancelled.has(id)) return null;
      const indexes: number[] = [];
      for (let index = start; index < end; index++) {
        if (rows[index].kind === "ctx" || rows[index].kind === (side === "old" ? "del" : "add")) indexes.push(index);
      }
      if (!indexes.length) continue;
      let grammarState: Parameters<typeof highlighter.codeToTokensBase>[1]["grammarState"];
      for (let from = 0; from < indexes.length; from += 100) {
        if (cancelled.has(id)) return null;
        const chunk = indexes.slice(from, from + 100);
        const code = chunk.map((index) => rows[index].text).join("\n");
        const tokens = highlighter.codeToTokensBase(code, {
          lang, theme, grammarState, tokenizeMaxLineLength: 10_000, tokenizeTimeLimit: 100,
        });
        grammarState = highlighter.getLastGrammarState(tokens);
        chunk.forEach((index, position) => {
          const lineTokens = tokens[position] ?? [];
          // Keep diff text authoritative if a grammar changes whitespace handling.
          if (lineTokens.map((token) => token.content).join("") !== rows[index].text) return;
          result[index] = compactSyntaxTokens(lineTokens, baseColor);
        });
        // Let newer file selections cancel before processing the next chunk.
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
    start = end;
  }
  return result;
}

const active = new Set<number>();
self.onmessage = (event: MessageEvent<
  { type: "cancel"; id: number } |
  { type: "highlight"; id: number; filePath: string; rows: DiffLine[]; palette: SyntaxPalette }
>) => {
  const request = event.data;
  if (request.type === "cancel") {
    if (active.has(request.id)) cancelled.add(request.id);
    return;
  }
  active.add(request.id);
  void (async () => {
    const { id, filePath, rows, palette } = request;
    try {
      const language = languageForDiffPath(filePath);
      if (!language || rows.reduce((length, row) => length + row.text.length, 0) > 300_000) {
        self.postMessage({ id, tokens: null });
        return;
      }
      await Promise.all([ensureLanguage(language), ensureTheme(palette)]);
      if (cancelled.has(id)) return;
      const highlighter = await highlighterPromise;
      const grammarId = grammarIdForDiffLanguage(language);
      const tokens = await tokenizeRows(rows, grammarId, palette.name, palette.text, id, highlighter);
      if (!cancelled.has(id)) self.postMessage({ id, tokens });
    } catch {
      if (!cancelled.has(id)) self.postMessage({ id, tokens: null });
    } finally {
      cancelled.delete(id);
      active.delete(id);
    }
  })();
};
