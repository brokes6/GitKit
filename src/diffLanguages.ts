export const DIFF_LANGUAGES = {
  bash: () => import("@shikijs/langs/bash"),
  c: () => import("@shikijs/langs/c"),
  cpp: () => import("@shikijs/langs/cpp"),
  css: () => import("@shikijs/langs/css"),
  dart: () => import("@shikijs/langs/dart"),
  dockerfile: () => import("@shikijs/langs/dockerfile"),
  go: () => import("@shikijs/langs/go"),
  groovy: () => import("@shikijs/langs/groovy"),
  html: () => import("@shikijs/langs/html"),
  java: () => import("@shikijs/langs/java"),
  javascript: () => import("@shikijs/langs/javascript"),
  json: () => import("@shikijs/langs/json"),
  jsx: () => import("@shikijs/langs/jsx"),
  kotlin: () => import("@shikijs/langs/kotlin"),
  makefile: () => import("@shikijs/langs/makefile"),
  markdown: () => import("@shikijs/langs/markdown"),
  objectivec: () => import("@shikijs/langs/objective-c"),
  properties: () => import("@shikijs/langs/properties"),
  python: () => import("@shikijs/langs/python"),
  rust: () => import("@shikijs/langs/rust"),
  scss: () => import("@shikijs/langs/scss"),
  sql: () => import("@shikijs/langs/sql"),
  svelte: () => import("@shikijs/langs/svelte"),
  swift: () => import("@shikijs/langs/swift"),
  toml: () => import("@shikijs/langs/toml"),
  tsx: () => import("@shikijs/langs/tsx"),
  typescript: () => import("@shikijs/langs/typescript"),
  vue: () => import("@shikijs/langs/vue"),
  xml: () => import("@shikijs/langs/xml"),
  yaml: () => import("@shikijs/langs/yaml"),
} as const;

export type DiffLanguage = keyof typeof DIFF_LANGUAGES;

const GRAMMAR_IDS: Partial<Record<DiffLanguage, string>> = {
  bash: "shellscript", dockerfile: "docker", makefile: "make", properties: "ini",
  objectivec: "objective-c",
};

export function grammarIdForDiffLanguage(language: DiffLanguage): string {
  return GRAMMAR_IDS[language] ?? language;
}

const EXTENSIONS: Record<string, DiffLanguage> = {
  c: "c", cc: "cpp", cpp: "cpp", cxx: "cpp", h: "c", hpp: "cpp", hxx: "cpp",
  m: "objectivec", mm: "objectivec",
  css: "css", scss: "scss", dart: "dart", go: "go", html: "html", htm: "html",
  java: "java", js: "javascript", jsx: "jsx", mjs: "javascript", cjs: "javascript",
  json: "json", kt: "kotlin", kts: "kotlin", md: "markdown", mdx: "markdown",
  py: "python", rs: "rust", sh: "bash", bash: "bash", zsh: "bash", sql: "sql",
  svelte: "svelte", swift: "swift", toml: "toml", ts: "typescript", mts: "typescript",
  cts: "typescript", tsx: "tsx", vue: "vue", xml: "xml", yml: "yaml", yaml: "yaml",
  gradle: "groovy", properties: "properties",
};

export function languageForDiffPath(path: string): DiffLanguage | null {
  const name = path.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  if (/^dockerfile(?:\..+)?$/.test(name)) return "dockerfile";
  if (name === "makefile" || name === "gnumakefile") return "makefile";
  if (name === "cargo.lock") return "toml";
  if (name === ".bashrc" || name === ".zshrc" || name === ".profile") return "bash";
  if (name === "gradlew") return "bash";
  const extension = name.split(".").pop() ?? "";
  return EXTENSIONS[extension] ?? null;
}
