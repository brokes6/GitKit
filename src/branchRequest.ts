/** Match repository identity across HTTPS, SSH and scp-style clone URLs. */
export function requestRepository(remoteUrl: string, instanceUrl: string): string | null {
  try {
    const instance = new URL(instanceUrl);
    const scp = !remoteUrl.includes("://") && remoteUrl.match(/^(?:[^@/:]+@)?([^/:]+):(.+)$/);
    const remote = new URL(scp ? `ssh://${scp[1]}/${scp[2]}` : remoteUrl);
    if (!["https:", "http:", "ssh:"].includes(remote.protocol) || remote.hostname.toLowerCase() !== instance.hostname.toLowerCase()) return null;
    if (remote.protocol !== "ssh:" && remote.origin !== instance.origin) return null;
    let path = decodeURIComponent(remote.pathname).replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
    const prefix = decodeURIComponent(instance.pathname).replace(/^\/+|\/+$/g, "");
    if (prefix && remote.protocol !== "ssh:" && path.startsWith(prefix + "/")) path = path.slice(prefix.length + 1);
    else if (prefix && remote.protocol !== "ssh:") return null;
    return path.includes("/") && !path.split("/").some(p => !p || p === "." || p === "..") ? path : null;
  } catch { return null; }
}

/** Render a pasteable command using only the validated API endpoint, never credentials. */
export function glabLoginCommand(instance: string): string | null {
  try {
    const url = new URL(instance);
    if (!["http:", "https:"].includes(url.protocol) || url.href !== url.origin + "/") return null;
    const ipv6 = url.hostname.startsWith("[");
    if (!(ipv6 ? /^\[[0-9a-f:]+\]$/i : /^[a-z0-9_][a-z0-9._-]*$/i).test(url.hostname)) return null;
    const hostname = ipv6 ? `"${url.hostname}"` : url.hostname;
    const apiHost = ipv6 ? `"${url.host}"` : url.host;
    return `glab auth login --hostname ${hostname}${url.port ? ` --api-host ${apiHost}` : ""} --api-protocol ${url.protocol.slice(0, -1)}`;
  } catch { return null; }
}

export function readGlabInstance(): string {
  try {
    const url = new URL(localStorage.getItem("gitkit.glab.instance") || "");
    return ["http:", "https:"].includes(url.protocol) && url.href === url.origin + "/" ? url.origin : "";
  } catch { return ""; }
}
