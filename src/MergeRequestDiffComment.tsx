import { useEffect, useRef, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { tf, translateNativeMessage, tx } from "./i18n";
import { mrErrorMessage } from "./mergeRequestHelpers";
import type { MrDiffCommentPosition, MrDiffCommentResult, MrDiffRefs, MrDiscussion } from "./mergeRequestTypes";

export interface MrLineCommentActions {
  oldPath: string;
  newPath: string;
  refs: MrDiffRefs;
  discussions: MrDiscussion[];
  disabledReason?: string;
  onSubmit: (position: MrDiffCommentPosition, body: string) => Promise<MrDiffCommentResult>;
  onOpenExternal: () => void;
}

export function MergeRequestDiffComment({ position, actions, onClose }: {
  position: MrDiffCommentPosition;
  actions: MrLineCommentActions;
  onClose: () => void;
}) {
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const submitRef = useRef(false);
  const aliveRef = useRef(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    aliveRef.current = true;
    inputRef.current?.focus();
    inputRef.current?.scrollIntoView({ block: "nearest" });
    return () => { aliveRef.current = false; };
  }, []);
  const submit = async () => {
    if (!body.trim() || submitRef.current || uncertain || actions.disabledReason) return;
    submitRef.current = true;
    setSending(true); setError(null);
    try {
      const result = await actions.onSubmit(position, body);
      if (!aliveRef.current) return;
      if (result.state === "uncertain") {
        setUncertain(true); setError(translateNativeMessage(result.message));
      } else onClose();
    } catch (cause) {
      if (aliveRef.current) setError(mrErrorMessage(cause));
    } finally {
      submitRef.current = false;
      if (aliveRef.current) setSending(false);
    }
  };
  return <form className="gkm-line-comment" aria-label={tx("行评论")} aria-busy={sending}
    onSubmit={event => { event.preventDefault(); void submit(); }}
    onKeyDown={event => {
      if (event.key === "Escape") event.stopPropagation();
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) {
        event.preventDefault(); void submit();
      }
    }}>
    <label className="gkm-line-comment-label">
      <span>{position.newLine !== null ? tf("对第 {0} 行发表评论", position.newLine) : tf("对删除的第 {0} 行发表评论", position.oldLine)}</span>
      <textarea ref={inputRef} rows={4} value={body} disabled={sending || uncertain}
        placeholder={tx("输入评论…")} onChange={event => { setBody(event.target.value); setError(null); }} />
    </label>
    {(error || actions.disabledReason) && <p className="gkm-line-comment-error" role="alert">{error || actions.disabledReason}
      {uncertain && <> <button className="gkm-text-button" type="button" onClick={actions.onOpenExternal}>{tx("在 GitLab 中查看")}</button></>}
    </p>}
    <div className="gkm-line-comment-actions">
      <button className="gkm-button gkm-button-primary" type="submit" disabled={!body.trim() || sending || uncertain || !!actions.disabledReason}>
        {sending && <LoaderCircle size={13} className="gkm-spin" aria-hidden="true" />}{tx(sending ? "正在添加评论…" : "添加评论")}
      </button>
      <button className="gkm-button" type="button" disabled={sending} onClick={onClose}>{tx("取消")}</button>
    </div>
  </form>;
}

export function MergeRequestLineDiscussions({ discussions }: { discussions: MrDiscussion[] }) {
  return <div className="gkm-line-discussions">{discussions.map(thread => <article className="gkm-line-thread" key={thread.id}>
    {thread.notes.filter(note => !note.system).map(note => <div className="gkm-line-note" key={note.id}>
      <div className="gkm-note-meta"><strong>{note.author.name || note.author.username}</strong>
        <span>{Number.isNaN(Date.parse(note.createdAt)) ? tx("时间未知") : new Intl.DateTimeFormat(document.documentElement.lang || undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(note.createdAt))}</span>
        {note.resolvable && <span className={note.resolved ? "gkm-resolved" : "gkm-unresolved"}>{tx(note.resolved ? "已解决" : "未解决")}</span>}
      </div>
      <div className="gkm-prose">{note.body}</div>
    </div>)}
  </article>)}</div>;
}
