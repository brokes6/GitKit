import { useCallback, useEffect, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "./git";
import { mrErrorMessage, mrVersionChanged, reviewVersion, sameMrRefs } from "./mergeRequestHelpers";
import type { MrActionResult, MrCommitMessages, MrDetail, MrDiffCommentPosition, MrDiffCommentResult, MrDiffVersion, MrDiscussion, MrDownloadedDiff, MrMergeOptions, MrMergeResult, MrParticipantCandidates, MrParticipantKind, MrParticipantsResult, MrSnapshot } from "./mergeRequestTypes";
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
  const selectionRequest = useRef(0);
  const renderedSelection = selectionRequest.current;
  const diffCommentInFlight = useRef(false);
  const participantRequest = useRef(0), participantsInFlight = useRef(false);
  const configureNative = useCallback(() => invoke<MrSnapshot>("mr_configure", {config:enabled ? {
    accountKey:"gitlab",url:instanceUrl,token,
  } : null}), [enabled,instanceUrl,token]);

  const applySnapshot = useCallback((snapshot: MrSnapshot, expectedKey: string) => {
    if (keyRef.current !== expectedKey || epochRef.current !== snapshot.epoch) return;
    setStored((previous) => {
      if (previous.key !== expectedKey || (previous.snapshot && snapshot.revision <= previous.snapshot.revision)) return previous;
      const latest = snapshot.selectedDetail?.summary.id === previous.selectedId ? snapshot.selectedDetail : previous.latest;
      return { ...previous, snapshot, latest, syncError: snapshot.error || snapshot.stale ? previous.syncError : null };
    });
  }, []);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    epochRef.current = null;
    selectionRequest.current++;
    participantRequest.current++;
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
    const request = detailRequest.current;
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
      if (request !== detailRequest.current || keyRef.current !== expected.key || epochRef.current !== expected.epoch) return;
      applySnapshot(snapshot,expected.key);
      const mrId = storeRef.current.selectedId;
      if (mrId !== null) {
        refreshingDetail = true;
        const latest = await invoke<MrDetail>("mr_detail",{mrId,epoch:expected.epoch,force:true});
        if (request === detailRequest.current && keyRef.current === expected.key && epochRef.current === expected.epoch) {
          setStored((previous) => request === detailRequest.current && previous.key === expected.key && previous.selectedId === mrId ?
            {...previous,latest,detail:previous.detail ?? latest,loading:false,error:null} : previous);
          void loadDiscussions(true);
        }
      }
    } catch(error) {
      if (request !== detailRequest.current || keyRef.current !== requestKey) return;
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
    selectionRequest.current++;
    participantRequest.current++;
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
  const loadDiscussions = async (force = false) => {
    const current = storeRef.current;
    if (!current.detail || (!force && (current.discussionsLoaded || current.discussionsLoading))) return;
    const request = ++discussionRequest.current, expected = context(), mrId = current.detail.summary.id;
    setStored((previous) => previous.key === expected.key && previous.selectedId === mrId
      ? {...previous,discussionsLoading:true,discussionsError:null} : previous);
    try {
      const discussions = await invoke<MrDiscussion[]>("mr_discussions",{mrId,epoch:expected.epoch,force});
      if (request !== discussionRequest.current || keyRef.current !== expected.key || epochRef.current !== expected.epoch) return;
      setStored((previous) => previous.key === expected.key && previous.selectedId === mrId
        ? {...previous,discussions,discussionsLoaded:true,discussionsLoading:false} : previous);
    } catch (error) {
      if (request === discussionRequest.current && keyRef.current === expected.key)
        setStored((previous) => previous.key === expected.key && previous.selectedId === mrId
          ? {...previous,discussionsLoading:false,discussionsError:mrErrorMessage(error)} : previous);
    }
  };
  const onTabChange = (tab: 'overview'|'changes'|'discussion') => {
    const failed = (error: unknown) => {
      if (keyRef.current === key) setStored((previous) => previous.key === key ? {...previous,error:mrErrorMessage(error)} : previous);
    };
    if (tab === 'changes') void loadDiff().catch(failed);
    if (tab === 'changes' || tab === 'discussion') void loadDiscussions().catch(failed);
  };

  const participantContext = () => {
    if (key !== keyRef.current || renderedSelection !== selectionRequest.current)
      throw new Error(tx("账号、合并请求或成员搜索已变化，请重新选择"));
    const expected = context(), current = storeRef.current;
    const detail = current.latest ?? current.detail;
    if (!detail || current.selectedId !== detail.summary.id || current.detail?.summary.id !== detail.summary.id)
      throw new Error(tx("请选择合并请求"));
    if (!current.snapshot?.user || detail.summary.author.id !== current.snapshot.user.id
      || !detail.canManageParticipants || detail.summary.state !== "opened")
      throw new Error(tx("只有创建者可以修改进行中的合并请求的指派人和审核者"));
    return {...expected,detail,mrId:detail.summary.id,selection:selectionRequest.current};
  };
  const participantCandidates = async (query: string, page: number): Promise<MrParticipantCandidates> => {
    const expected = participantContext();
    if (!Number.isSafeInteger(page) || page < 1) throw new Error(tx("成员列表页码无效"));
    const request = ++participantRequest.current, detailGeneration = detailRequest.current;
    const result = await invoke<MrParticipantCandidates>("mr_participant_candidates", {
      mrId:expected.mrId,epoch:expected.epoch,query,page,
    });
    const current = storeRef.current;
    if (request !== participantRequest.current || detailGeneration !== detailRequest.current
      || keyRef.current !== expected.key || epochRef.current !== expected.epoch
      || selectionRequest.current !== expected.selection || current.key !== expected.key
      || current.selectedId !== expected.mrId)
      throw new Error(tx("账号、合并请求或成员搜索已变化，请重新选择"));
    participantContext();
    return result;
  };
  const updateParticipants = async (kind: MrParticipantKind, userIds: number[], expectedUserIds: number[]): Promise<MrParticipantsResult> => {
    const expected = participantContext();
    if (kind !== 'assignee' && kind !== 'reviewer') throw new Error(tx("合并请求成员类型无效"));
    const validIds = (ids: number[]) => Array.isArray(ids)
      && ids.every((id) => Number.isSafeInteger(id) && id > 0) && new Set(ids).size === ids.length;
    if (!validIds(userIds) || !validIds(expectedUserIds)) throw new Error(tx("请选择有效的项目成员"));
    const currentIds = (kind === 'assignee' ? expected.detail.assignees : expected.detail.reviewers).map((user) => user.id);
    if (currentIds.length !== expectedUserIds.length || currentIds.some((id) => !expectedUserIds.includes(id)))
      throw new Error(tx("指派人或审核者已变化，请刷新后重新选择"));
    if (participantsInFlight.current) throw new Error(tx("正在保存合并请求成员，请稍候"));
    const stillSelected = () => {
      const current = storeRef.current;
      return keyRef.current === expected.key && epochRef.current === expected.epoch
        && selectionRequest.current === expected.selection && current.key === expected.key
        && current.selectedId === expected.mrId;
    };
    participantsInFlight.current = true;
    participantRequest.current++;
    // Assignment changes update the current remote detail while the reviewed source stays pinned.
    const request = ++detailRequest.current;
    try {
      let result: MrParticipantsResult;
      try {
        result = await invoke<MrParticipantsResult>("mr_update_participants", {
          mrId:expected.mrId,epoch:expected.epoch,kind,userIds:[...userIds],expectedUserIds:[...expectedUserIds],
        });
      } catch (error) {
        if (typeof error === 'object' && error && 'kind' in error && error.kind === 'uncertain')
          result = {state:'uncertain',message:mrErrorMessage(error),detail:null};
        else throw error;
      }
      if (!stillSelected()) return {
        state:'uncertain',message:tx("账号或合并请求已切换，请到原 GitLab 项目核实成员修改结果，勿重复提交"),detail:null,
      };
      if (result.detail && (result.detail.summary.id !== expected.mrId
        || result.detail.summary.projectId !== expected.detail.summary.projectId
        || result.detail.summary.iid !== expected.detail.summary.iid)) result = {
        state:'uncertain',message:tx("无法确认合并请求成员修改结果，请刷新核实，勿重复提交"),detail:null,
      };
      // Discard detail reads started before or during this mutation so they cannot restore old members.
      detailRequest.current++;
      participantRequest.current++;
      setStored((previous) => {
        if (previous.key !== expected.key || previous.selectedId !== expected.mrId) return previous;
        const snapshotDetail = previous.snapshot?.selectedDetail;
        const latest = snapshotDetail?.summary.id === expected.mrId && result.detail
          && Date.parse(snapshotDetail.summary.updatedAt) > Date.parse(result.detail.summary.updatedAt)
          ? snapshotDetail : result.detail ?? previous.latest;
        return {...previous,latest,loading:false,error:null};
      });
      return result;
    } finally {
      participantsInFlight.current = false;
      if (request === detailRequest.current) {
        detailRequest.current++;
        if (stillSelected()) setStored((previous) => previous.key === expected.key && previous.selectedId === expected.mrId
          ? {...previous,loading:false} : previous);
      }
    }
  };

  const createDiffComment = async (position: MrDiffCommentPosition, body: string): Promise<MrDiffCommentResult> => {
    const expected = context(), current = storeRef.current;
    const detail = current.detail, diffVersion = current.diffVersion;
    const reviewedVersion = detail ? reviewVersion(detail) : null;
    if (!detail || current.selectedId !== detail.summary.id || !diffVersion || !reviewedVersion
      || diffVersion.id !== reviewedVersion.id || !sameMrRefs(diffVersion.refs, reviewedVersion.refs)
      || detail.summary.sha !== diffVersion.refs.headSha || mrVersionChanged(detail, current.latest))
      throw new Error(tx("服务器差异版本已改变，请重新审阅"));
    if (!body.trim()) throw new Error(tx("请输入评论内容"));
    const file = diffVersion.files.find((file) => file.oldPath === position.oldPath && file.newPath === position.newPath);
    const validLine = (line: number | null) => line === null || (Number.isSafeInteger(line) && line > 0);
    if (!file || !file.diff || file.tooLarge || file.collapsed || !validLine(position.oldLine) || !validLine(position.newLine)
      || (position.oldLine === null && position.newLine === null))
      throw new Error(tx("请选择当前差异中的代码行"));
    if (diffCommentInFlight.current) throw new Error(tx("正在添加评论，请稍候"));
    const mrId = detail.summary.id;
    const selection = selectionRequest.current;
    const stillSelected = () => {
      const selected = storeRef.current;
      return keyRef.current === expected.key && epochRef.current === expected.epoch
        && selectionRequest.current === selection
        && selected.key === expected.key && selected.selectedId === mrId
        && !mrVersionChanged(detail, selected.detail)
        && selected.diffVersion?.id === diffVersion.id && sameMrRefs(selected.diffVersion.refs, diffVersion.refs);
    };
    diffCommentInFlight.current = true;
    // Reads started before or during a write cannot restore the old merge/discussion state.
    const request = ++detailRequest.current;
    try {
      let result: MrDiffCommentResult;
      try {
        result = await invoke<MrDiffCommentResult>("mr_create_diff_comment", {
          mrId, epoch: expected.epoch, reviewedVersionId: diffVersion.id, reviewedRefs: diffVersion.refs,
          expectedTargetBranch: detail.summary.targetBranch, body, position,
        });
      } catch (error) {
        if (typeof error === 'object' && error && 'kind' in error && error.kind === 'uncertain')
          result = {state:'uncertain',message:mrErrorMessage(error),discussion:null};
        else throw error;
      }
      if (!stillSelected()) return {
        state:'uncertain',message:tx("账号或合并请求已切换，请到原 GitLab 项目核实评论结果，勿重复提交"),discussion:null,
      };
      // A new explicit review may already be loading; let it finish and replace the pinned diff.
      const completed = request === detailRequest.current ? ++detailRequest.current : detailRequest.current;
      discussionRequest.current++;
      setStored((previous) => {
        if (previous.key !== expected.key || previous.selectedId !== mrId) return previous;
        const discussions = result.discussion
          ? [...previous.discussions.filter((discussion) => discussion.id !== result.discussion!.id), result.discussion]
          : previous.discussions;
        return {...previous,discussions,discussionsLoaded:false,discussionsLoading:false,discussionsError:null};
      });
      // A confirmed comment remains successful even if either following read fails.
      void invoke<MrDetail>("mr_detail", {mrId,epoch:expected.epoch,force:true}).then((latest) => {
        if (completed !== detailRequest.current || !stillSelected()) return;
        setStored((previous) => completed === detailRequest.current && previous.key === expected.key && previous.selectedId === mrId
          ? {...previous,latest,error:null} : previous);
      }).catch((error) => {
        if (completed !== detailRequest.current || !stillSelected()) return;
        setStored((previous) => previous.key === expected.key && previous.selectedId === mrId
          ? {...previous,error:mrErrorMessage(error)} : previous);
      });
      void loadDiscussions(true);
      return result;
    } finally {
      diffCommentInFlight.current = false;
      if (request === detailRequest.current) detailRequest.current++;
    }
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
      void loadDiscussions(true);
    } catch (error) {
      if (request === detailRequest.current && keyRef.current === expected.key)
        setStored((previous) => ({...previous,loading:false,error:mrErrorMessage(error)}));
      throw error;
    }
  };
  const downloadDiff = async (review: MrDetail): Promise<MrDownloadedDiff | null> => {
    const expected = context(), current = storeRef.current;
    const detail = review, version = reviewVersion(detail);
    if (!current.detail || mrVersionChanged(detail, current.detail) || current.selectedId !== detail.summary.id || !version)
      throw new Error(tx("GitLab 尚未提供当前审阅版本的差异，请刷新后重试"));
    const downloaded = await invoke<MrDownloadedDiff | null>("mr_download_diff", {
      mrId: detail.summary.id, epoch: expected.epoch, reviewedVersionId: version.id,
      reviewedRefs: version.refs, expectedTargetBranch: detail.summary.targetBranch,
    });
    if (keyRef.current !== expected.key || epochRef.current !== expected.epoch
      || storeRef.current.selectedId !== detail.summary.id)
      throw new Error(tx("账号或合并请求已切换，请重新下载差异"));
    if (downloaded && (downloaded.versionId !== version.id || !sameMrRefs(downloaded.refs, version.refs)))
      throw new Error(tx("服务器差异版本已改变，请重新审阅"));
    return downloaded;
  };
  const runAction = async (command: "mr_close" | "mr_approve", reviewedSha?: string): Promise<MrActionResult> => {
    const expected = context(), current = storeRef.current, mrId = current.selectedId;
    if (mrId === null) throw new Error(tx("请选择合并请求"));
    const reviewedVersion = current.detail ? reviewVersion(current.detail) : null;
    const expectedTargetBranch = current.detail?.summary.targetBranch;
    if (command === "mr_approve" && (!reviewedSha || !expectedTargetBranch || !reviewedVersion))
      throw new Error(tx("请先查看并确认本次提交差异"));
    const revision = current.snapshot!.revision;
    // Discard reads started before, or while, a mutation is in flight.
    const request = ++detailRequest.current;
    try {
      const result = await invoke<MrActionResult>(command,{mrId,epoch:expected.epoch,...(command === "mr_approve" ? {
        reviewedSha,expectedTargetBranch,reviewedRefs:reviewedVersion!.refs,reviewedVersionId:reviewedVersion!.id,
      } : {})});
      if (keyRef.current !== expected.key || epochRef.current !== expected.epoch)
        throw new Error(tx("账号已切换，请到原 GitLab 项目核实操作结果，勿重复提交"));
      if (request !== detailRequest.current) return result;
      const completed = ++detailRequest.current;
      setStored((previous) => {
        if (completed !== detailRequest.current || previous.key !== expected.key || previous.selectedId !== mrId) return previous;
        const snapshotDetail = previous.snapshot?.selectedDetail;
        const alreadyConfirmed = snapshotDetail && (mrVersionChanged(result.detail, snapshotDetail)
          || (result.detail && Date.parse(snapshotDetail.summary.updatedAt) > Date.parse(result.detail.summary.updatedAt))
          || snapshotDetail.summary.state !== "opened"
          || (result.state === "approved" && snapshotDetail.approvals.approvedBy.some((user) => user.id === previous.snapshot?.user?.id))
          || result.state === "uncertain");
        const latest = snapshotDetail?.summary.id === mrId && previous.snapshot!.revision > revision && alreadyConfirmed
          ? snapshotDetail : result.detail?.summary.id === mrId ? result.detail : previous.latest;
        // The reviewed source/version stays pinned; only the current permissions and state change.
        return {...previous,latest,loading:false,error:null};
      });
      return result;
    } finally {
      if (request === detailRequest.current) {
        detailRequest.current++;
        if (keyRef.current === expected.key && epochRef.current === expected.epoch)
          setStored((previous) => previous.key === expected.key && previous.selectedId === mrId ? {...previous,loading:false} : previous);
      }
    }
  };
  const close = () => runAction("mr_close");
  const approve = (reviewedSha: string) => runAction("mr_approve", reviewedSha);
  const commitMessages = async (): Promise<MrCommitMessages> => {
    const expected = context(), current = storeRef.current, mrId = current.selectedId;
    const summary = current.detail?.summary;
    if (mrId === null || summary?.id !== mrId || !summary.sha || !summary.targetBranch)
      throw new Error(tx("请选择合并请求"));
    if (mrVersionChanged(current.detail, current.latest))
      throw new Error(tx("合并请求或审阅版本已变化，请重新加载提交消息"));
    // This is a read; observe the current request generation without invalidating other reads.
    const request = detailRequest.current;
    const messages = await invoke<MrCommitMessages>("mr_commit_messages", {mrId,epoch:expected.epoch});
    const selected = storeRef.current, selectedSummary = selected.detail?.summary;
    if (keyRef.current !== expected.key || epochRef.current !== expected.epoch || request !== detailRequest.current
      || selected.key !== expected.key || selected.selectedId !== mrId || selectedSummary?.id !== mrId
      || selectedSummary.projectId !== summary.projectId || selectedSummary.iid !== summary.iid
      || selectedSummary.sha !== summary.sha || selectedSummary.targetBranch !== summary.targetBranch
      || mrVersionChanged(selected.detail, selected.latest)
      || messages.mrId !== mrId || messages.projectId !== summary.projectId || messages.iid !== summary.iid
      || messages.sha !== summary.sha || messages.targetBranch !== summary.targetBranch)
      throw new Error(tx("合并请求或审阅版本已变化，请重新加载提交消息"));
    return messages;
  };
  const merge = async (options: MrMergeOptions): Promise<MrMergeResult> => {
    const expected = context(), mrId = storeRef.current.selectedId;
    if (mrId === null) throw new Error(tx("请选择合并请求"));
    const expectedTargetBranch = storeRef.current.detail?.summary.targetBranch;
    const reviewedVersion = storeRef.current.detail ? reviewVersion(storeRef.current.detail) : null;
    if (!expectedTargetBranch || !reviewedVersion) throw new Error(tx("请选择合并请求"));
    const request = ++detailRequest.current;
    try {
      const result = await invoke<MrMergeResult>("mr_merge",{mrId,epoch:expected.epoch,expectedTargetBranch,
        reviewedRefs:reviewedVersion.refs,reviewedVersionId:reviewedVersion.id,...options});
      if (keyRef.current !== expected.key || epochRef.current !== expected.epoch) throw new Error(tx("账号已切换，请重新检查合并结果"));
      return result;
    } finally {
      if (request === detailRequest.current) {
        detailRequest.current++;
        if (keyRef.current === expected.key && epochRef.current === expected.epoch)
          setStored((previous) => previous.key === expected.key && previous.selectedId === mrId ? {...previous,loading:false} : previous);
      }
    }
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
    selectionRequest.current++;
    participantRequest.current++;
    detailRequest.current++; diffRequest.current++; discussionRequest.current++;
    setStored((previous) => ({...empty(key),snapshot:previous.snapshot}));
    setListState({key,open:false});
  };
  return {...value,error:value.error || value.syncError,enabled,listOpen,anchorRef,select,refresh,onTabChange,reviewLatest,downloadDiff,createDiffComment,participantCandidates,updateParticipants,merge,close,approve,commitMessages,openExternal,backWorkspace,
    toggleList:()=>setListState({key,open:hasRequests && !listOpen}),closeList:()=>setListState({key,open:false}),
    backList:()=>hasRequests ? setListState({key,open:true}) : backWorkspace()};
}
