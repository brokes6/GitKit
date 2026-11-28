import { useCallback, useEffect, useMemo, useReducer } from "react";
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
  // An old account or repository read can only publish into its own cache.
  const cache = useMemo(() => new Map<string, Entry>(), [connection]);
  const [revision, publish] = useReducer((n: number) => n + 1, 0);
  const read = useCallback((name: string, head: string, force = false, completedId?: number) => {
    if (!connection) return;
    const previous = cache.get(name);
    if (!force && previous?.tip === head && Date.now() - previous.at < REFRESH_MS) return;
    const oldRequest = previous?.request ?? null;
    const request = oldRequest?.id === completedId ? null : oldRequest;
    const entry: Entry = { tip: head, at: Date.now(), request };
    cache.set(name, entry);
    if (request !== oldRequest) publish();
    void lookupBranchRequest({ ...connection, source: name }).then(data => {
      if (cache.get(name) !== entry) return;
      entry.request = data.requests.find(item => item.id !== completedId) ?? null;
      publish();
    }).catch(() => {
      if (cache.get(name) === entry) entry.at = 0;
    });
  }, [cache, connection]);

  useEffect(() => {
    for (const { name, head } of branches) read(name, head);
    const onFocus = () => {
      for (const { name, head } of branches) read(name, head);
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [branches, read]);

  const refresh = useCallback((source: string, completedId?: number) => {
    const branch = branches.find(b => b.name === source);
    if (branch) read(source, branch.head, true, completedId);
  }, [branches, read]);

  const requests = useMemo(() => {
    const out: Record<string, LaneRequest> = {};
    if (!connection) return out;
    const sameInbox = connection.provider === "gitlab" && !!inboxInstance
      && connection.instanceUrl.replace(/\/+$/, "") === inboxInstance.replace(/\/+$/, "");
    for (const { name } of branches) {
      const request = cache.get(name)?.request;
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
  }, [revision, cache, branches, connection, inbox, inboxInstance]);
  return { requests, refresh };
}

/** Underlying request for a lane branch, for opening it. */
export function laneRequestItem(request: LaneRequest, branch: string): PlatformRequest {
  return { id: request.id, number: request.number, url: request.url, title: request.title, target: request.target, source: branch };
}
