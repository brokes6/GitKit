import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { AlertCircle, LoaderCircle, Search, UsersRound, X } from "lucide-react";
import { Modal, type ThemeColors } from "./App";
import { tf, translateNativeMessage, tx } from "./i18n";
import { mrErrorMessage } from "./mergeRequestHelpers";
import type { MrDetail, MrParticipantCandidates, MrParticipantKind, MrParticipantsResult, MrUser } from "./mergeRequestTypes";
import { Skeleton } from "./Skeleton";
import { DialogPresence, useDialogPresence } from "./DialogPresence";
import { MergeRequestAvatar } from "./MergeRequestAvatar";

interface Props {
  theme: ThemeColors;
  style: CSSProperties;
  detail: MrDetail;
  viewer: MrUser | null;
  disabled: boolean;
  onCandidates: (query: string, page: number) => Promise<MrParticipantCandidates>;
  onUpdate: (kind: MrParticipantKind, userIds: number[], expectedUserIds: number[]) => Promise<MrParticipantsResult>;
  onRefresh: () => Promise<void>;
  onBusyChange: (busy: boolean) => void;
  onNeedsRecheck: () => void;
}

const idsKey = (users: MrUser[]) => users.map(user => user.id).sort((a, b) => a - b).join(",");

export function MergeRequestParticipants(props: Props) {
  const [open, setOpen] = useState<MrParticipantKind | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef<MrParticipantKind | null>(null);
  const buttons = useRef<Partial<Record<MrParticipantKind, HTMLButtonElement | null>>>({});
  const focusState = useRef({ open, busy }); focusState.current = { open, busy };
  const canEdit = props.detail.canManageParticipants && props.detail.summary.state === "opened"
    && !!props.viewer && props.detail.summary.author.id === props.viewer.id;
  const close = (kind: MrParticipantKind) => { restoreFocus.current = kind; setOpen(null); };

  const restorePickerFocus = () => {
    if (focusState.current.open || focusState.current.busy || !restoreFocus.current) return;
    if (document.querySelector('[role="dialog"][aria-modal="true"]:not([aria-hidden="true"])')) {
      restoreFocus.current = null;
      return;
    }
    const edit = buttons.current[restoreFocus.current];
    const section = rootRef.current?.closest(".gkm-detail");
    const target = edit && !edit.disabled ? edit : section?.querySelector<HTMLElement>(".gkm-tabs-refresh:not(:disabled), #gkm-detail-title");
    target?.focus({ preventScroll: true });
    restoreFocus.current = null;
  };

  return <div ref={rootRef} className="gkm-participants">
    {(["assignee", "reviewer"] as const).map(kind => {
      const users = (kind === "assignee" ? props.detail.assignees : props.detail.reviewers) || [];
      const label = tx(kind === "assignee" ? "指派人" : "审核者");
      return <section className="gkm-participant" key={kind} aria-labelledby={`gkm-${kind}-title`}>
        <div className="gkm-participant-head"><h3 id={`gkm-${kind}-title`}>{label}<span>{users.length}</span></h3>
          {canEdit && <button ref={element => { buttons.current[kind] = element; }} type="button" className="gkm-text-button"
            aria-label={tx(kind === "assignee" ? "编辑指派人" : "编辑审核者")} aria-haspopup="dialog" aria-expanded={open === kind} aria-controls={`gkm-${kind}-picker`}
            disabled={props.disabled || busy} onClick={() => { setNotice(null); setOpen(open === kind ? null : kind); }}>{tx("编辑")}</button>}
        </div>
        {users.length ? <div className="gkm-participant-users">{users.map(user => <div className="gkm-participant-user" key={user.id} title={`${user.name} @${user.username}`}>
          <MergeRequestAvatar user={user} /><div><strong>{user.name || user.username}</strong><small>@{user.username}</small></div>
        </div>)}</div> : <p className="gkm-participant-none">{tx("未分配")}</p>}
        <DialogPresence onExited={restorePickerFocus}>{open === kind ? <ParticipantPicker key={kind} {...props} kind={kind} users={users} canEdit={canEdit}
          onClose={() => close(kind)} onSaved={message => { setNotice(message); close(kind); }}
          onBusyChange={value => { setBusy(value); props.onBusyChange(value); }} /> : null}</DialogPresence>
      </section>;
    })}
    {!canEdit && <p className="gkm-participant-note">{tx("仅创建者可编辑指派人和审核者。")}</p>}
    {notice && <p className="gkm-participant-status" role="status">{translateNativeMessage(notice)}</p>}
  </div>;
}

function ParticipantPicker({ theme, style, kind, users, viewer, canEdit, disabled, onCandidates, onUpdate, onRefresh, onBusyChange, onNeedsRecheck, onClose, onSaved }: Props & {
  kind: MrParticipantKind; users: MrUser[]; canEdit: boolean; onClose: () => void; onSaved: (message: string) => void;
}) {
  const { closing } = useDialogPresence();
  const closingRef = useRef(closing); closingRef.current = closing;
  const [baseline] = useState(() => users);
  const [selected, setSelected] = useState(users);
  const [query, setQuery] = useState("");
  const [candidates, setCandidates] = useState<MrUser[]>([]);
  const [nextPage, setNextPage] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [recheck, setRecheck] = useState(false);
  const [saving, setSaving] = useState(false);
  const [retry, setRetry] = useState(0);
  const alive = useRef(true), busy = useRef(false), request = useRef(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  const candidatesRef = useRef(onCandidates); candidatesRef.current = onCandidates;
  const changedRemotely = idsKey(users) !== idsKey(baseline);
  const changed = idsKey(selected) !== idsKey(baseline);
  const locked = disabled || saving || closing || recheck || changedRemotely || !canEdit;

  const close = () => { if (!busy.current && !closingRef.current) closeRef.current(); };

  useLayoutEffect(() => {
    if (closing) return;
    alive.current = true;
    const appRoot = document.getElementById("root");
    const wasInert = appRoot?.inert ?? false;
    if (appRoot) appRoot.inert = true;
    searchRef.current?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      if (closingRef.current) {
        if (event.key === "Escape" || event.key === "Tab") { event.preventDefault(); event.stopPropagation(); }
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault(); event.stopPropagation(); close();
      } else if (event.key === "Tab") {
        const dialog = bodyRef.current?.closest('[role="dialog"]');
        const controls = dialog ? Array.from(dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)')) : [];
        const first = controls[0], last = controls[controls.length - 1];
        if (!dialog?.contains(document.activeElement)) { event.preventDefault(); first?.focus(); }
        else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      alive.current = false; request.current++;
      document.removeEventListener("keydown", onKey, true);
      if (appRoot) appRoot.inert = wasInert;
    };
  }, [closing]);

  useEffect(() => {
    if (closing) return;
    const generation = ++request.current;
    setCandidates([]); setNextPage(null); setLoadError(null); setLoading(true);
    const timer = window.setTimeout(() => {
      if (closingRef.current) return;
      void candidatesRef.current(query.trim(), 1).then(result => {
        if (!alive.current || closingRef.current || generation !== request.current) return;
        setCandidates(result.users); setNextPage(result.nextPage);
      }).catch(cause => {
        if (alive.current && !closingRef.current && generation === request.current) setLoadError(mrErrorMessage(cause));
      }).finally(() => { if (alive.current && !closingRef.current && generation === request.current) setLoading(false); });
    }, query ? 250 : 0);
    return () => { window.clearTimeout(timer); request.current++; };
  }, [query, retry, closing]);

  async function loadMore() {
    if (closingRef.current || loading || nextPage === null) return;
    const generation = ++request.current;
    setLoading(true); setLoadError(null);
    try {
      const result = await candidatesRef.current(query.trim(), nextPage);
      if (!alive.current || closingRef.current || generation !== request.current) return;
      setCandidates(previous => [...new Map([...previous, ...result.users].map(user => [user.id, user])).values()]);
      setNextPage(result.nextPage);
    } catch (cause) {
      if (alive.current && !closingRef.current && generation === request.current) setLoadError(mrErrorMessage(cause));
    } finally { if (alive.current && !closingRef.current && generation === request.current) setLoading(false); }
  }

  function toggle(user: MrUser) {
    if (locked) return;
    setSelected(previous => previous.some(item => item.id === user.id) ? previous.filter(item => item.id !== user.id) : [...previous, user]);
  }

  async function save() {
    if (busy.current || closingRef.current || locked || !changed) return;
    busy.current = true; setSaving(true); onBusyChange(true); setSaveError(null);
    try {
      const result = await onUpdate(kind, selected.map(user => user.id), baseline.map(user => user.id));
      if (!alive.current) return;
      if (result.state === "updated" && result.detail) onSaved(result.message);
      else { setSaveError(result.message); setRecheck(true); onNeedsRecheck(); }
    } catch (cause) {
      if (alive.current) { setSaveError(mrErrorMessage(cause)); setRecheck(true); onNeedsRecheck(); }
    } finally {
      busy.current = false;
      onBusyChange(false);
      if (alive.current) setSaving(false);
    }
  }

  async function refresh() {
    if (busy.current || closingRef.current) return;
    busy.current = true; setSaving(true);
    try { await onRefresh(); if (alive.current) onClose(); }
    catch (cause) { if (alive.current) setSaveError(mrErrorMessage(cause)); }
    finally { busy.current = false; if (alive.current) setSaving(false); }
  }

  const footer = <><span className="gkm-participant-selection-count">{tf("已选择 {0} 人", selected.length)}</span><button type="button" className="gkm-button" disabled={saving || closing} onClick={close}>{tx("取消")}</button><button type="button" className="gkm-button gkm-button-primary" disabled={locked || !changed} onClick={() => void save()}>{saving && <LoaderCircle size={12} className="gkm-spin" aria-hidden="true" />}{tx(saving ? "正在保存…" : "保存")}</button></>;
  return createPortal(<div className="gkm-export gkm-participant-dialog" style={style}>
    <Modal theme={theme} width={440} Icon={UsersRound} title={tx(kind === "assignee" ? "选择指派人" : "选择审核者")} onClose={close} footer={footer}>
    <div ref={bodyRef} className="gkm-participant-picker" id={`gkm-${kind}-picker`}
    onKeyDown={event => {
      if (event.key === "ArrowDown" && event.target === searchRef.current) { event.preventDefault(); listRef.current?.querySelector<HTMLInputElement>('input:not(:disabled)')?.focus(); }
    }}>
    <label className="gkm-participant-search"><Search size={14} aria-hidden="true" /><input ref={searchRef} type="search" value={query} maxLength={100}
      aria-label={tx("搜索项目成员")} placeholder={tx("搜索姓名或用户名")} disabled={locked} onChange={event => setQuery(event.target.value)} /></label>
    <div className="gkm-participant-shortcuts"><button className="gkm-text-button" type="button" disabled={locked || !selected.length} onClick={() => setSelected([])}>{tx("未分配")}</button>
      {viewer && <button className="gkm-text-button" type="button" disabled={locked || selected.some(user => user.id === viewer.id)} onClick={() => setSelected(previous => [...previous, viewer])}>{tx("分配给自己")}</button>}
    </div>
    {selected.length > 0 && <div className="gkm-participant-selected" aria-label={tx("已选择的成员")}>{selected.map(user => <button key={user.id} type="button" disabled={locked}
      title={`${user.name} @${user.username}`} aria-label={tf("移除 {0}", user.name || user.username)} onClick={() => toggle(user)}><span>{user.name || user.username}</span><X size={11} aria-hidden="true" /></button>)}</div>}
    <div ref={listRef} className="gkm-participant-options" aria-busy={loading}>
      {candidates.map(user => <label className="gkm-participant-option" key={user.id} title={`${user.name} @${user.username}`}><input type="checkbox"
        checked={selected.some(item => item.id === user.id)} disabled={locked} onChange={() => toggle(user)} /><MergeRequestAvatar user={user} size={28} /><span><strong>{user.name || user.username}</strong><small>@{user.username}</small></span></label>)}
      {loading && <div className="gkm-participant-skeleton" role="status" aria-label={tx("正在加载项目成员")}><Skeleton height={26} /><Skeleton height={26} /><Skeleton height={26} /></div>}
      {!loading && !loadError && !candidates.length && <p className="gkm-participant-empty">{tx(query ? "没有匹配的项目成员" : "没有可选择的项目成员")}</p>}
      {loadError && <div className="gkm-participant-error" role="alert">{translateNativeMessage(loadError)}<button className="gkm-text-button" type="button" disabled={locked} onClick={() => nextPage ? void loadMore() : setRetry(value => value + 1)}>{tx("重试")}</button></div>}
      {!loading && !loadError && nextPage !== null && <button type="button" className="gkm-text-button gkm-participant-more" disabled={locked} onClick={() => void loadMore()}>{tx("加载更多成员")}</button>}
    </div>
    {(saveError || changedRemotely || !canEdit) && <div className="gkm-participant-error" role="alert"><AlertCircle size={13} aria-hidden="true" /><span>{translateNativeMessage(saveError || tx(changedRemotely ? "成员已被更新，请刷新后重新选择。" : "仅创建者可编辑指派人和审核者。"))}
      <button className="gkm-text-button" type="button" disabled={saving || closing} onClick={() => void refresh()}>{tx("刷新状态")}</button></span></div>}
    </div>
    </Modal>
  </div>, document.body);
}
