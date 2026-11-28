import { useEffect, useMemo, useRef, useState } from "react";
import { lookupBranchRequest, type PlatformRequest } from "../git";
import type { RequestConnection } from "../useBranchRequest";
import type { MrSummary } from "../mergeRequestTypes";
import type { LaneRequest } from "./types";

// Open merge/pull requests for the branches shown in the lanes. One lookup per
// branch, cached per connection, refreshed on window focus (at most every 30 s)
// and when the branch's tip moves. GitLab inbox rows add pipeline / merge status.

const REFRESH_MS = 30_000;

interface Entry { tip: string; at: number; request: PlatformRequest | null }

export function useLaneRequests(connection: RequestConnection | null, branches: { name: string; head: string }[],
  inbox: MrSummary[] | undefined, inboxInstance: string | null) {
  const [entries, setEntries] = useState<Record<string, Entry>>({});
  const [focusTick, setFocusTick] = useState(0);
  const inflight = useRef(new Set<string>());
  const key = connection ? `${connection.provider}|${connection.instanceUrl}|${connection.remoteUrl}` : "";
  const keyRef = useRef(key);

  useEffect(() => { keyRef.current = key; inflight.current.clear(); setEntries({}); }, [key]);
  useEffect(() => {
    const onFocus = () => setFocusTick((n) => n + 1);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  const wanted = branches.map((b) => `${b.name}\u0000${b.head}`).join("\u0001");
  useEffect(() => {
    if (!connection) return;
    const now = Date.now();
    for (const { name, head } of branches) {
      const prev = entries[name];
      const stale = !prev || prev.tip !== head || now - prev.at > REFRESH_MS;
      if (!stale || inflight.current.has(name)) continue;
      inflight.current.add(name);
      const forKey = key;
      lookupBranchRequest({ ...connection, source: name }).then(
        (data) => {
          if (keyRef.current !== forKey) return;
          setEntries((e) => ({ ...e, [name]: { tip: head, at: Date.now(), request: data.requests[0] ?? null } }));
        },
        // A failed lookup just means "unknown"; retry on the next focus / tip change.
        () => { if (keyRef.current === forKey) setEntries((e) => ({ ...e, [name]: { tip: head, at: Date.now(), request: prev?.request ?? null } })); },
      ).finally(() => { inflight.current.delete(name); });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, wanted, focusTick]);

  return useMemo(() => {
    const out: Record<string, LaneRequest> = {};
    if (!connection) return out;
    const sameInbox = connection.provider === "gitlab" && !!inboxInstance
      && connection.instanceUrl.replace(/\/+$/, "") === inboxInstance.replace(/\/+$/, "");
    for (const { name } of branches) {
      const request = entries[name]?.request;
      if (!request) continue;
      const row = sameInbox ? inbox?.find((item) => item.id === request.id) : undefined;
      out[name] = {
        id: request.id, number: request.number,
        provider: connection.provider,
        label: `${connection.provider === "gitlab" ? "!" : "#"}${request.number}`,
        title: request.title, url: request.url, target: request.target,
        draft: row?.draft, pipeline: row?.pipelineStatus ?? null, mergeStatus: row?.detailedMergeStatus ?? null,
        inboxId: row?.id,
      };
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, connection, inbox, inboxInstance, wanted]);
}

/** Underlying request for a lane branch, for opening it. */
export function laneRequestItem(request: LaneRequest, branch: string): PlatformRequest {
  return { id: request.id, number: request.number, url: request.url, title: request.title, target: request.target, source: branch };
}
