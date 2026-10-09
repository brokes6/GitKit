import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { AlertCircle, Check, CheckCircle2, Copy, Download, FileText, LoaderCircle, Sparkles } from "lucide-react";
import { Modal, type ThemeColors } from "./App";
import { tf, tx } from "./i18n";
import { mrErrorMessage } from "./mergeRequestHelpers";
import { buildMrReviewPrompt } from "./mrReviewPrompt";
import { useDialogPresence } from "./DialogPresence";
import type { MrDetail, MrDownloadedDiff } from "./mergeRequestTypes";

export function MergeRequestDownload({ theme, style, detail, unavailable, onDownload, onClose }: {
  theme: ThemeColors; style: CSSProperties; detail: MrDetail; unavailable: string | null;
  onDownload: (review: MrDetail) => Promise<MrDownloadedDiff | null>; onClose: () => void;
}) {
  const { closing } = useDialogPresence();
  const [review, setReview] = useState(detail);
  const [downloaded, setDownloaded] = useState<MrDownloadedDiff | null>(null);
  const [prompt, setPrompt] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyFailures, setCopyFailures] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const busyRef = useRef(false);
  const aliveRef = useRef(true);
  const copyFailedRef = useRef(false);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  const displayedDetail = downloaded ? review : detail;
  const closingRef = useRef(closing); closingRef.current = closing;
  const close = () => { if (!busyRef.current && !closingRef.current) closeRef.current(); };
  const focusAction = () => {
    if (primaryRef.current && !primaryRef.current.disabled) primaryRef.current.focus();
    else bodyRef.current?.closest('[role="dialog"]')?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  };

  useLayoutEffect(() => {
    if (closing) return;
    aliveRef.current = true;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const appRoot = document.getElementById("root");
    const wasInert = appRoot?.inert ?? false;
    if (appRoot) appRoot.inert = true;
    focusAction();
    const onKey = (event: KeyboardEvent) => {
      const dialog = bodyRef.current?.closest('[role="dialog"]');
      if (event.key === "Escape") {
        event.preventDefault(); event.stopPropagation(); close();
      } else if (event.key === "Tab" && dialog) {
        const controls = Array.from(dialog.querySelectorAll<HTMLElement>('button:not(:disabled), textarea'));
        const first = controls[0], last = controls[controls.length - 1];
        if (!dialog.contains(document.activeElement)) { event.preventDefault(); first?.focus(); }
        else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      aliveRef.current = false;
      document.removeEventListener("keydown", onKey, true);
      if (appRoot) appRoot.inert = wasInert;
      const dialog = bodyRef.current?.closest('[role="dialog"]');
      const otherDialog = Array.from(document.querySelectorAll('[role="dialog"][aria-modal="true"]'))
        .some(element => element !== dialog && element.getAttribute("aria-hidden") !== "true");
      if (!otherDialog && previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, [closing]);

  useEffect(() => { if (prompt && !closing) promptRef.current?.focus(); }, [prompt, closing]);

  async function download() {
    if (busyRef.current || closingRef.current || unavailable) return;
    busyRef.current = true;
    setBusy(true); setError(null);
    try {
      const pinned = detail;
      const saved = await onDownload(pinned);
      if (aliveRef.current && saved) { setReview(pinned); setDownloaded(saved); }
    } catch (cause) {
      if (aliveRef.current) setError(mrErrorMessage(cause));
    } finally {
      busyRef.current = false;
      if (aliveRef.current) setBusy(false);
    }
  }

  useEffect(() => {
    if (busy || closing) return;
    if (copyFailedRef.current) { promptRef.current?.focus(); promptRef.current?.select(); }
    else focusAction();
  }, [busy, copyFailures, closing]);

  async function copyPrompt() {
    if (!prompt || busyRef.current || closingRef.current) return;
    busyRef.current = true; copyFailedRef.current = false; setBusy(true); setCopied(false); setError(null);
    try {
      await navigator.clipboard.writeText(prompt);
      if (aliveRef.current) setCopied(true);
    } catch {
      if (aliveRef.current) { copyFailedRef.current = true; setCopyFailures(count => count + 1); setError(tx("无法复制到剪贴板")); }
    } finally {
      busyRef.current = false;
      if (aliveRef.current) setBusy(false);
    }
  }

  return createPortal(<div className="gkm-export" style={style}>
    <Modal title={tx("下载差异与 AI 审查")} Icon={Download} theme={theme} width={620} onClose={close}
      footer={<><button type="button" className="gkm-button" onClick={close} disabled={busy}>{tx("关闭")}</button>
        <button ref={primaryRef} type="button" className="gkm-button gkm-button-primary" disabled={busy || !downloaded && !!unavailable}
          onClick={() => prompt ? void copyPrompt() : downloaded ? (setPrompt(buildMrReviewPrompt(review, downloaded)), setError(null)) : void download()}>
          {busy ? <LoaderCircle size={14} className="gkm-spin" aria-hidden="true" /> : prompt ? copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" /> : downloaded ? <Sparkles size={14} aria-hidden="true" /> : <Download size={14} aria-hidden="true" />}
          {tx(busy ? prompt ? "正在复制…" : "正在下载…" : prompt ? copied ? "已复制提示词" : "复制提示词" : downloaded ? "获取 AI 提示词" : "下载代码差异")}
        </button></>}>
      <div ref={bodyRef} className="gkm-export-body">
        <div className="gkm-export-request"><span>{displayedDetail.summary.projectPathWithNamespace} !{displayedDetail.summary.iid}</span><strong>{displayedDetail.summary.title}</strong></div>
        <p className="gkm-export-intro">{tx(prompt ? "将提示词和刚下载的 .diff 文件一起发给 AI，即可开始审查。" : downloaded ? "差异文件已保存，接下来获取这次改动的 AI 审查提示词。" : "先下载代码差异，再获取可直接发给 AI 的审查提示词。")}</p>
        <div className={`gkm-export-file${downloaded ? " is-saved" : ""}`}>
          {downloaded ? <CheckCircle2 size={19} aria-hidden="true" /> : <FileText size={19} aria-hidden="true" />}
          <div><strong>{downloaded ? downloaded.fileName : tx("文本差异 (.diff)")}</strong><span>{downloaded ? tf("已保存 · 版本 {0}", downloaded.refs.headSha.slice(0, 12)) : `${displayedDetail.summary.sourceBranch} → ${displayedDetail.summary.targetBranch}`}</span></div>
        </div>
        {prompt ? <label className="gkm-export-prompt"><span>{tx("AI 审查提示词")}</span><textarea ref={promptRef} value={prompt} readOnly rows={12} spellCheck={false} /></label>
          : !downloaded && <p className="gkm-export-note">{tx("下载 GitLab 返回的原始文本差异，受服务器差异限制；二进制文件内容不会包含。")}</p>}
        {(!downloaded && unavailable || error) && <div className="gkm-banner gkm-banner-error" role="alert"><AlertCircle size={15} aria-hidden="true" /><div>{error || unavailable}</div></div>}
        <span className="gkm-export-status" role="status">{copied ? tx("提示词已复制，请同时附上下载的差异文件。") : downloaded && !prompt ? tx("代码差异已下载") : ""}</span>
      </div>
    </Modal>
  </div>, document.body);
}
