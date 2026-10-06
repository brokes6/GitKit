import { useCallback, useEffect, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "./git";
import { mrErrorMessage, reviewVersion, sameMrRefs } from "./mergeRequestHelpers";
import type { MrDetail, MrDiffVersion, MrDiscussion, MrMergeResult, MrSnapshot } from "./mergeRequestTypes";
import { tx } from "./i18n";

interface Store {
  key: string; snapshot: MrSnapshot | null; selectedId: number | null;
  detail: MrDetail | null; latest: MrDetail | null; loading: boolean; error: string | null; syncError: string | null;
  diffVersion: MrDiffVersion | null; diffLoading: boolean; diffError: string | null;
  discussions: MrDiscussion[]; discussionsLoaded: boolean; discussionsLoading: boolean; discussionsError: string | null;
}
const empty = (key: string): Store => ({ key, snapshot: null, selectedId: null, detail: null, latest: null,
  loading: false, error: null, syncError: null, diffVersion: null, diffLoading: false, diffError: null,
  discussions: [], discussionsLoaded: false, discussionsLoading: false, discussionsError: null });

/** The account inbox survives local repository switches; Rust owns every timer. */
export function useMergeRequests({ url, token, credentialRevision }: {
  url: string; token: string; credentialRevision: number;
}) {
  const enabled = !!token.trim() && isTauri();
  const instanceUrl = url.trim() || "https://gitlab.com";
  const key = JSON.stringify(["gitlab", instanceUrl, credentialRevision, enabled]);
  const keyRef = useRef(key); keyRef.current = key;
  const [stored, setStored] = useState<Store>(() => empty(key));
  const value = enabled && stored.key === key ? stored : empty(key);
  const storeRef = useRef(value); storeRef.current = value;
  const [listState, setListState] = useState<{key:string;open:boolean}>({key,open:false});
  const hasRequests = enabled && (value.snapshot?.total ?? 0) > 0;
  const listOpen = hasRequests && listState.key === key && listState.open;
  const anchorRef = useRef<HTMLButtonElement>(null);
  const epochRef = useRef<number | null>(null);
  const detailRequest = useRef(0), diffRequest = useRef(0), discussionRequest = useRef(0);
  const configureNative = useCallback(() => invoke<MrSnapshot>("mr_configure", {config:enabled ? {
    accountKey:"gitlab",url:instanceUrl,token,
  } : null}), [enabled,instanceUrl,token]);

  const applySnapshot = useCallback((snapshot: MrSnapshot, expectedKey: string) => {
    if (keyRef.current !== expectedKey || epochRef.current !== snapshot.epoch) return;
    setStored((previous) => {
      if (previous.key !== expectedKey || (previous.snapshot && snapshot.revision < previous.snapshot.revision)) return previous;
      const latest = snapshot.selectedDetail?.summary.id === previous.selectedId ? snapshot.selectedDetail : previous.latest;
      return { ...previous, snapshot, latest, syncError: snapshot.error || snapshot.stale ? previous.syncError : null };
    });
  }, []);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    epochRef.current = null;
    detailRequest.current++; diffRequest.current++; discussionRequest.current++;
    setStored(empty(key));
    if (!isTauri()) return;
    const configure = async () => {
      if (!enabled) {
        // Deactivate the native service locally; disabled accounts have no subscriptions or reads.
        await configureNative();
        return;
      }
      unlisten = await listen<MrSnapshot>("merge-request-state", ({payload}) => {
        if (!disposed) applySnapshot(payload, key);
      });
      if (disposed) { unlisten(); return; }
      const snapshot = await configureNative();
      if (disposed || keyRef.current !== key) return;
      epochRef.current = snapshot.epoch;
      setStored((previous) => previous.key === key ? {...previous,snapshot} : previous);
      // Recover any completion event that arrived before the configure handshake.
      const current = await invoke<MrSnapshot>("mr_snapshot");
      if (!disposed) applySnapshot(current, key);
    };
    void configure().catch((error) => {
      if (!disposed) setStored((previous) => previous.key === key ? {...previous,syncError:mrErrorMessage(error)} : previous);
    });
    return () => { disposed = true; unlisten?.(); };
  }, [key, enabled, configureNative, applySnapshot]);

  useEffect(() => {
    if (!hasRequests) setListState((previous) => previous.open ? {key,open:false} : previous);
  }, [key, hasRequests]);

  useEffect(() => {
    if (!enabled || epochRef.current === null) return;
    const report = () => { void invoke("mr_visibility", {visibility:{listOpen,detailId:value.selectedId,online:navigator.onLine}})
      .catch((error) => setStored((previous) => previous.key === key ? {...previous,syncError:mrErrorMessage(error)} : previous)); };
    report();
    window.addEventListener("online", report); window.addEventListener("offline", report);
    return () => { window.removeEventListener("online",report); window.removeEventListener("offline",report); };
  }, [key, enabled, listOpen, value.selectedId, value.snapshot?.epoch]);

  const context = () => {
    const current = storeRef.current;
    if (!enabled || current.key !== keyRef.current || !current.snapshot || epochRef.current !== current.snapshot.epoch)
      throw new Error(tx("请先连接 GitLab 账号并等待同步完成"));
    return {key:current.key,epoch:current.snapshot.epoch};
  };
  const refresh = async () => {
    const requestKey = key;
    let refreshingDetail = false;
    try {
      // Retry a failed configuration handshake without requiring a credential edit.
      if (enabled && epochRef.current === null) {
        const configured = await configureNative();
        if (keyRef.current !== requestKey) return;
        epochRef.current = configured.epoch;
        setStored((previous) => previous.key === requestKey ? {...previous,snapshot:configured} : previous);
        storeRef.current = {...storeRef.current,snapshot:configured};
      }
      const expected = context();
      const snapshot = await invoke<MrSnapshot>("mr_refresh", {force:true});
      applySnapshot(snapshot,expected.key);
      const mrId = storeRef.current.selectedId;
      if (mrId !== null) {
        refreshingDetail = true;
        const latest = await invoke<MrDetail>("mr_detail",{mrId,epoch:expected.epoch,force:true});
        if (keyRef.current === expected.key && epochRef.current === expected.epoch)
          setStored((previous) => previous.selectedId === mrId ? {...previous,latest,detail:previous.detail ?? latest,loading:false,error:null} : previous);
      }
    } catch(error) {
      if (keyRef.current === requestKey) setStored((previous) => previous.key === requestKey ?
        {...previous,...(refreshingDetail ? {error:mrErrorMessage(error)} : {syncError:mrErrorMessage(error)})} : previous);
      throw error;
    }
  };

  const select = async (mrId: number) => {
    if (storeRef.current.selectedId === mrId && storeRef.current.detail) {
      setListState({key,open:false});
      return;
    }
    const request = ++detailRequest.current;
    diffRequest.current++; discussionRequest.current++;
    setListState({key,open:false});
    setStored((previous) => ({...empty(key),snapshot:previous.key === key ? previous.snapshot : null,selectedId:mrId,loading:true}));
    try {
      const expected = context();
      const detail = await invoke<MrDetail>("mr_detail",{mrId,epoch:expected.epoch});
      if (request !== detailRequest.current || keyRef.current !== expected.key || epochRef.current !== expected.epoch) return;
      setStored((previous) => ({...previous,detail,latest:detail,loading:false,error:null}));
    } catch (error) {
      if (request === detailRequest.current && keyRef.current === key)
        setStored((previous) => ({...previous,loading:false,error:mrErrorMessage(error)}));
    }
  };

  const loadDiff = async () => {
    const current = storeRef.current;
    if (!current.detail || current.diffVersion || current.diffLoading) return;
    const version = reviewVersion(current.detail);
    if (!version) { setStored((previous) => ({...previous,diffError:tx("GitLab 尚未提供当前审阅版本的差异，请刷新后重试")})); return; }
    const request = ++diffRequest.current;
    const expected = context(), mrId = current.detail.summary.id;
    setStored((previous) => ({...previous,diffLoading:true,diffError:null}));
    try {
      const diffVersion = await invoke<MrDiffVersion>("mr_diffs",{mrId,versionId:version.id,epoch:expected.epoch});
      if (!sameMrRefs(diffVersion.refs,version.refs)) throw new Error(tx("服务器差异版本已改变，请重新审阅"));
      if (request !== diffRequest.current || keyRef.current !== expected.key || epochRef.current !== expected.epoch) return;
      setStored((previous) => ({...previous,diffVersion,diffLoading:false,diffError:null}));
    } catch (error) {
      if (request === diffRequest.current && keyRef.current === expected.key)
        setStored((previous) => ({...previous,diffLoading:false,diffError:mrErrorMessage(error)}));
    }
  };
  const loadDiscussions = async () => {
    const current = storeRef.current;
    if (!current.detail || current.discussionsLoaded || current.discussionsLoading) return;
    const request = ++discussionRequest.current, expected = context(), mrId = current.detail.summary.id;
    setStored((previous) => ({...previous,discussionsLoading:true,discussionsError:null}));
    try {
      const discussions = await invoke<MrDiscussion[]>("mr_discussions",{mrId,epoch:expected.epoch});
      if (request !== discussionRequest.current || keyRef.current !== expected.key || epochRef.current !== expected.epoch) return;
      setStored((previous) => ({...previous,discussions,discussionsLoaded:true,discussionsLoading:false}));
    } catch (error) {
      if (request === discussionRequest.current && keyRef.current === expected.key)
        setStored((previous) => ({...previous,discussionsLoading:false,discussionsError:mrErrorMessage(error)}));
    }
  };
  const onTabChange = (tab: 'overview'|'changes'|'discussion') => {
    const failed = (error: unknown) => {
      if (keyRef.current === key) setStored((previous) => previous.key === key ? {...previous,error:mrErrorMessage(error)} : previous);
    };
    if (tab === 'changes') void loadDiff().catch(failed);
    if (tab === 'discussion') void loadDiscussions().catch(failed);
  };

  const reviewLatest = async () => {
    const expected = context(), mrId = storeRef.current.selectedId;
    if (mrId === null) return;
    const request = ++detailRequest.current;
    diffRequest.current++; discussionRequest.current++;
    setStored((previous) => ({...previous,loading:true,error:null,diffLoading:false,discussionsLoading:false}));
    try {
      const detail = await invoke<MrDetail>("mr_detail",{mrId,epoch:expected.epoch,force:true});
      const version = reviewVersion(detail);
      if (!version) throw new Error(tx("GitLab 尚未提供当前审阅版本的差异，请刷新后重试"));
      const diffVersion = await invoke<MrDiffVersion>("mr_diffs",{mrId,versionId:version.id,epoch:expected.epoch});
      if (!sameMrRefs(diffVersion.refs,version.refs)) throw new Error(tx("服务器差异版本已改变，请重新审阅"));
      if (request !== detailRequest.current || keyRef.current !== expected.key || epochRef.current !== expected.epoch) return;
      setStored((previous) => ({...previous,detail,latest:detail,diffVersion,diffLoading:false,diffError:null,loading:false,
        discussions:[],discussionsLoaded:false,discussionsLoading:false,discussionsError:null}));
    } catch (error) {
      if (request === detailRequest.current && keyRef.current === expected.key)
        setStored((previous) => ({...previous,loading:false,error:mrErrorMessage(error)}));
      throw error;
    }
  };
  const merge = async (options: {reviewedSha:string;squash:boolean;deleteSource:boolean}): Promise<MrMergeResult> => {
    const expected = context(), mrId = storeRef.current.selectedId;
    if (mrId === null) throw new Error(tx("请选择合并请求"));
    const expectedTargetBranch = storeRef.current.detail?.summary.targetBranch;
    const reviewedVersion = storeRef.current.detail ? reviewVersion(storeRef.current.detail) : null;
    if (!expectedTargetBranch || !reviewedVersion) throw new Error(tx("请选择合并请求"));
    const result = await invoke<MrMergeResult>("mr_merge",{mrId,epoch:expected.epoch,expectedTargetBranch,
      reviewedRefs:reviewedVersion.refs,reviewedVersionId:reviewedVersion.id,...options});
    if (keyRef.current !== expected.key || epochRef.current !== expected.epoch) throw new Error(tx("账号已切换，请重新检查合并结果"));
    return result;
  };
  const openExternal = () => {
    try { const expected=context(), mrId=storeRef.current.selectedId;
      if (mrId !== null) void invoke("mr_open",{mrId,epoch:expected.epoch}).catch((error) => {
        if (keyRef.current === expected.key && epochRef.current === expected.epoch)
          setStored((previous) => previous.key === expected.key ? {...previous,error:mrErrorMessage(error)} : previous);
      });
    } catch(error) {
      if (keyRef.current === key) setStored((previous) => previous.key === key ? {...previous,error:mrErrorMessage(error)} : previous);
    }
  };
  const backWorkspace = () => {
    detailRequest.current++; diffRequest.current++; discussionRequest.current++;
    setStored((previous) => ({...empty(key),snapshot:previous.snapshot}));
    setListState({key,open:false});
  };
  return {...value,error:value.error || value.syncError,enabled,listOpen,anchorRef,select,refresh,onTabChange,reviewLatest,merge,openExternal,backWorkspace,
    toggleList:()=>setListState({key,open:hasRequests && !listOpen}),closeList:()=>setListState({key,open:false}),
    backList:()=>hasRequests ? setListState({key,open:true}) : backWorkspace()};
}
