export interface GithubTokenInfo {
  login: string;
  name: string | null;
  token_kind: "classic" | "fine_grained" | "oauth" | "other";
  scopes: string[] | null;
  // RFC 3339 normalized by Rust. Missing response headers remain unknown.
  expires_at: string | null;
}

export const GITHUB_TOKEN_KINDS = {
  classic: "Classic Token", fine_grained: "细粒度 Token", oauth: "OAuth Token", other: "其他 Token",
} as const;

export const GITHUB_CAPABILITIES = [
  { id: "profile", title: "读取公开资料", detail: "查看当前账号公开信息" },
  { id: "private_read", title: "拉取私有代码", detail: "克隆、拉取私有仓库" },
  { id: "push", title: "推送代码", detail: "通过 HTTPS 推送提交" },
  { id: "pull_request", title: "创建拉取请求", detail: "创建、更新 PR" },
  { id: "create_repo", title: "创建仓库", detail: "创建账号下的仓库" },
  { id: "workflow", title: "更新工作流", detail: "新增、修改 Actions 文件" },
  { id: "org", title: "读取组织信息", detail: "查看组织与团队成员关系" },
  { id: "packages_read", title: "下载软件包", detail: "读取 GitHub Packages" },
  { id: "packages_write", title: "发布软件包", detail: "发布到 GitHub Packages" },
] as const;

export function githubTokenExpiry(info: GithubTokenInfo | null, now = Date.now()) {
  const unknown = { date: "无法确认", label: "有效期未知", tone: "muted", expired: false } as const;
  if (!info?.expires_at) return unknown;
  const end = Date.parse(info.expires_at);
  if (!Number.isFinite(end)) return unknown;
  const date = `${new Date(end).toISOString().slice(0, 16).replace("T", " ")} UTC`;
  const remaining = end - now;
  if (remaining <= 0) return { date, label: "已过期", tone: "red", expired: true } as const;
  const days = Math.floor(remaining / 86_400_000);
  const label = days ? `剩余 ${days} 天` : remaining >= 3_600_000 ? `剩余 ${Math.floor(remaining / 3_600_000)} 小时` : "不足 1 小时";
  return { date, label, tone: remaining <= 7 * 86_400_000 ? "amber" : "green", expired: false } as const;
}

export function githubCapability(info: GithubTokenInfo | null, id: typeof GITHUB_CAPABILITIES[number]["id"], now = Date.now()): "granted" | "denied" | "public" | "unknown" | "inactive" {
  if (!info) return "unknown";
  if (githubTokenExpiry(info, now).expired) return "inactive";
  // /user authenticated successfully. This only confirms access to public profile data.
  if (id === "profile") return "granted";
  if (info.scopes === null || !["classic", "oauth"].includes(info.token_kind)) return "unknown";
  const has = (...scopes: string[]) => scopes.some(scope => info.scopes!.includes(scope));
  switch (id) {
    case "private_read": return has("repo") ? "granted" : "denied";
    case "push": case "pull_request": case "create_repo":
      return has("repo") ? "granted" : has("public_repo") ? "public" : "denied";
    case "workflow":
      if (!has("workflow")) return "denied";
      return has("repo") ? "granted" : has("public_repo") ? "public" : "denied";
    case "org": return has("read:org", "write:org", "admin:org") ? "granted" : "denied";
    case "packages_read": return has("read:packages", "write:packages") ? "granted" : "denied";
    case "packages_write": return has("write:packages") ? "granted" : "denied";
  }
}

export function validGithubUrl(url: string): boolean {
  if (!url.trim()) return true;
  try {
    const parsed = new URL(url.trim());
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) return false;
    return !["github.com", "api.github.com"].includes(parsed.hostname) || (!parsed.pathname.replace(/\//g, "") && !parsed.port);
  } catch { return false; }
}
