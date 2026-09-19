export interface GitlabTokenInfo {
  name: string | null;
  scopes: string[] | null;
  expires_at: string | null;
  expiry_known: boolean;
  active: boolean | null;
  revoked: boolean | null;
  granular: boolean;
}

// PAT scope semantics: https://docs.gitlab.com/security/tokens/access_token_scopes/
// These are token capabilities, not project roles or protected-branch permissions.
export const GITLAB_CAPABILITIES = [
  { title: "读取个人资料", detail: "查看当前用户信息", scopes: ["api", "read_api", "read_user"] },
  { title: "查看项目", detail: "读取有权访问的项目", scopes: ["api", "read_api"] },
  { title: "查看合并请求", detail: "读取 MR 与讨论", scopes: ["api", "read_api"] },
  { title: "创建合并请求", detail: "创建、更新 MR", scopes: ["api"] },
  { title: "拉取代码", detail: "通过 HTTPS 克隆、拉取", scopes: ["api", "read_repository", "write_repository"] },
  { title: "推送代码", detail: "通过 HTTPS 推送提交", scopes: ["api", "write_repository"] },
  { title: "拉取容器镜像", detail: "读取容器镜像仓库", scopes: ["api", "read_api", "read_registry"] },
  { title: "推送容器镜像", detail: "写入容器镜像仓库", scopes: ["api", "write_registry"] },
  { title: "轮换当前令牌", detail: "通过 API 更新自身 Token", scopes: ["api", "self_rotate"] },
] as const;

export function tokenExpiry(info: GitlabTokenInfo | null, now = Date.now()) {
  const unknown = { label: "无法确认", tone: "muted", expired: false, date: "无法确认" } as const;
  if (!info?.expiry_known) return unknown;
  if (info.expires_at === null) return { label: "未设置到期时间", tone: "muted", expired: false, date: "无到期时间" } as const;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(info.expires_at)) return unknown;
  // GitLab expires tokens at the START of the expiry date in UTC.
  const end = Date.parse(`${info.expires_at}T00:00:00Z`);
  if (!Number.isFinite(end) || new Date(end).toISOString().slice(0, 10) !== info.expires_at) return unknown;
  const date = `${info.expires_at} 00:00 UTC`;
  const remaining = end - now;
  if (remaining <= 0) return { label: "已过期", tone: "red", expired: true, date } as const;
  const days = Math.floor(remaining / 86_400_000);
  const label = days ? `剩余 ${days} 天` : remaining >= 3_600_000 ? `剩余 ${Math.floor(remaining / 3_600_000)} 小时` : "不足 1 小时";
  return { label, tone: remaining <= 7 * 86_400_000 ? "amber" : "green", expired: false, date } as const;
}

export function tokenCapability(info: GitlabTokenInfo | null, capability: typeof GITLAB_CAPABILITIES[number], now = Date.now()): "granted" | "denied" | "unknown" | "inactive" {
  if (!info) return "unknown";
  if (info.revoked || info.active === false || tokenExpiry(info, now).expired) return "inactive";
  if (!info.scopes || info.granular) return "unknown";
  return capability.scopes.some(scope => info.scopes!.includes(scope)) ? "granted" : "denied";
}
