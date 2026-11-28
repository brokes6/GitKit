import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { BranchSelect } from "../BranchSelect";
import type { ThemeColors } from "../App";
import { branchColor } from "../git";
import { tf, tx } from "../i18n";
import { buildLaneViews, selectLaneIds } from "./laneLayout";
import type { LaneView } from "./laneLayout";
import {
  DEFAULT_LANE_SETTINGS, MAX_LANES, parseBranchList, setLaneSettings, setLaneTrunk, useLaneSettings, useLaneTrunk,
} from "./settings";
import type { LaneSettings, SlotRule } from "./settings";
import { buildStackModel } from "./stackModel";
import type { LaneBranch, LaneCommit } from "./stackModel";
import { loadBases } from "./util";

// Settings → 分支区域: how the lanes workspace fills its cards.

const TRUNK_NAMES = ["main", "master", "trunk", "develop"];
type RuleKind = SlotRule["kind"];
const RULE_KINDS: RuleKind[] = ["current", "parent", "trunk", "recent", "named"];

export interface LanesSettingsProject {
  path: string;
  name: string;
  /** Local branch names. */
  branches: string[];
  current?: string;
  /** The repository as the lanes workspace sees it, for the live card preview. */
  laneBranches?: LaneBranch[];
  laneCommits?: LaneCommit[];
}

function ruleLabel(kind: RuleKind): string {
  switch (kind) {
    case "current": return tx("当前分支");
    case "parent": return tx("当前分支的基础分支");
    case "trunk": return tx("主分支");
    case "recent": return tx("最近修改的分支");
    case "named": return tx("指定分支…");
  }
}

function ruleHint(rule: SlotRule, project?: LanesSettingsProject): ReactNode {
  switch (rule.kind) {
    case "current": return tx("签出的分支，连同未提交的改动");
    case "parent": return tx("当前分支是从哪个分支拉出来的；在主分支上时改为最近修改");
    case "trunk": return tx("始终显示主分支");
    case "recent": return tx("还没显示的分支里，最近提交或合并过的那个");
    case "named": {
      if (!rule.names.length) return tx("按顺序填写分支名，显示第一个存在的；都没有时改为最近修改");
      if (!project) return tx("按顺序显示第一个存在的分支；都没有时改为最近修改");
      const hit = rule.names.find((n) => project.branches.includes(n));
      return hit ? tf("{0} 中会显示 {1}", project.name, hit) : tf("{0} 中没有这些分支，会改为最近修改", project.name);
    }
  }
}

function previewRole(view: LaneView, current?: string) {
  if (view.role === "parent" && current) return tf("{0} 的基础分支", current);
  if (view.role === "recent") return tx("最近修改");
  if (view.role === "current" && view.id === current) return tx("当前分支");
  return view.isTrunk ? tx("主分支") : tx("默认展示");
}

function LanesPreview({ project, settings, trunk, highlighted }: {
  project?: LanesSettingsProject; settings: LaneSettings; trunk: string; highlighted: number | null;
}) {
  const { path, current, laneBranches, laneCommits } = project ?? {};
  const { envOrder, slots, recentIncludesMerged } = settings;
  const count = Math.min(settings.maxLanes, MAX_LANES);
  const model = useMemo(() => path && laneBranches && laneCommits
    ? buildStackModel(laneBranches, laneCommits, loadBases(path), { trunk: trunk || undefined, longLived: envOrder })
    : null, [path, laneBranches, laneCommits, trunk, envOrder]);
  const views = useMemo(() => model ? buildLaneViews(model, selectLaneIds(model, {
    count, current, rules: slots, includeMerged: recentIncludesMerged,
  })) : [], [model, count, current, slots, recentIncludesMerged]);

  return <section className="gk-settings-group gk-lanes-preview">
    <h3>{tx("卡片预览")}</h3>
    <ol className="gk-lanes-preview-list">
      {slots.slice(0, count).map((rule, at) => {
        const view = views[at];
        // Recent picks fill the first free positions, so no unfilled slot can precede one.
        const fellBack = view?.role === "recent" && rule.kind !== "recent";
        const missingNames = fellBack && rule.kind === "named" && rule.names.length > 0
          && rule.names.every((name) => name !== model?.trunk && !model?.nodes.has(name));
        const fallback = missingNames ? tf("未找到 {0}，改为最近修改", rule.names.join(", "))
          : fellBack ? tx("改为最近修改") : null;
        return <li key={at} className="gk-lanes-preview-card" data-highlighted={highlighted === at || undefined}>
          <span className="gk-lanes-preview-index" aria-hidden="true">{at + 1}</span>
          {view ? <div key={view.id} className="gk-lanes-preview-branch">
            <div className="gk-lanes-preview-name" title={view.id}>
              <span className="gk-lanes-preview-dot" style={{ backgroundColor: branchColor(view.id) }} aria-hidden="true" />
              <strong>{view.id}</strong>
            </div>
            <div className="gk-lanes-preview-meta">
              <span>{previewRole(view, current)}</span>
              <span>{tf("{0} 个提交", view.rows.length + view.hidden)}</span>
            </div>
            {(view.isTrunk || view.longLived || view.merged) && <div className="gk-lanes-preview-tags">
              {view.isTrunk && <span>{tx("主干")}</span>}
              {view.longLived && !view.isTrunk && <span>{tx("长期分支")}</span>}
              {view.merged && <span>{tx("已合并")}</span>}
            </div>}
            {fallback && <p className="gk-lanes-preview-fallback">{fallback}</p>}
          </div> : <span className="gk-lanes-preview-placeholder">
            {model ? tx("无可显示的分支") : ruleLabel(rule.kind)}
          </span>}
        </li>;
      })}
    </ol>
  </section>;
}

export function LanesSettings({ theme, project }: { theme: ThemeColors; project?: LanesSettingsProject }) {
  const settings = useLaneSettings();
  const trunk = useLaneTrunk(project?.path ?? "");
  const update = (patch: Partial<LaneSettings>) => setLaneSettings((prev) => ({ ...prev, ...patch }));
  const setSlot = (at: number, rule: SlotRule) => update({ slots: settings.slots.map((r, i) => i === at ? rule : r) });
  const detected = project
    ? TRUNK_NAMES.find((n) => project.branches.includes(n)) ?? project.current ?? project.branches[0] ?? "main"
    : "";
  // Remounts the text inputs after 恢复默认 so they show the reset values.
  const [resetKey, setResetKey] = useState(0);
  const [highlighted, setHighlighted] = useState<number | null>(null);
  const dirty = JSON.stringify({ ...settings, pixels: DEFAULT_LANE_SETTINGS.pixels }) !== JSON.stringify(DEFAULT_LANE_SETTINGS) || !!trunk;

  return <section className="gk-settings-page">
    <header className="gk-settings-page-header">
      <div className="gk-settings-heading-group">
        <h2 className="gk-heading gk-settings-heading">{tx("分支区域")}</h2>
        <p className="gk-settings-description">{tx("调整新界面主页上的分支卡片：主分支是哪条、每个卡片默认显示什么、点开的分支放在哪里。")}</p>
      </div>
      <button type="button" className="gk-settings-secondary" disabled={!dirty}
        onClick={() => { setLaneSettings(prev => ({ ...DEFAULT_LANE_SETTINGS, pixels: prev.pixels })); if (project) setLaneTrunk(project.path, ""); setResetKey((k) => k + 1); }}>
        {tx("恢复默认")}
      </button>
    </header>

    <LanesPreview project={project} settings={settings} trunk={trunk} highlighted={highlighted} />

    <Group title={tx("主分支")}>
      <Row label={tx("主分支")} description={project
        ? tf("只对 {0} 生效。用来判断分支从哪里拉出、是否已经合并", project.name)
        : tx("打开一个仓库后可以设置")}>
        <div className="gk-lanes-settings-select">
          <BranchSelect theme={theme} aria-label={tx("主分支")} value={trunk}
            options={project ? ["", ...project.branches] : [""]} disabled={!project}
            placeholder={project ? tf("自动（{0}）", detected) : tx("自动")}
            onChange={(name) => project && setLaneTrunk(project.path, name)} />
        </div>
      </Row>
    </Group>

    <Group title={tx("卡片默认显示")}>
      {settings.slots.map((rule, at) => <SlotRow key={`${resetKey}:${at}`} at={at} rule={rule} theme={theme} project={project}
        hidden={at >= settings.maxLanes} onChange={(r) => setSlot(at, r)} onHighlight={setHighlighted} />)}
    </Group>

    <Group title={tx("打开分支")}>
      <Row label={tx("点开的分支放在")} description={tx("从底部「当前分支」里点开一个不在屏幕上的分支时，替换哪一个卡片")}>
        <Segment value={settings.openAt} onChange={(openAt) => update({ openAt })}
          options={[...Array.from({ length: MAX_LANES }, (_, i) => ({ value: i + 1, label: tf("第 {0} 个", i + 1) })),
            { value: 0, label: tx("最右边") }]} />
      </Row>
    </Group>

    <Group title={tx("显示")}>
      <Row label={tx("最多显示几个卡片")} description={tx("窗口较窄时会自动减少")}>
        <Segment value={settings.maxLanes} onChange={(maxLanes) => update({ maxLanes })}
          options={Array.from({ length: MAX_LANES }, (_, i) => ({ value: i + 1, label: String(i + 1) }))} />
      </Row>
      <Row label={tx("「最近修改」包含已合并的分支")} description={tx("关闭后，已经合并到主分支的分支不会自动占用卡片")}>
        <Switch label={tx("「最近修改」包含已合并的分支")} checked={settings.recentIncludesMerged}
          onChange={(recentIncludesMerged) => update({ recentIncludesMerged })} />
      </Row>
      <Row label={tx("长期分支顺序")} description={tx("用于卡片上的「合入」进度，例如 test, pre, master。留空则按合并历史自动判断")}>
        <ListInput key={resetKey} label={tx("长期分支顺序")} value={settings.envOrder} placeholder={tx("自动")}
          onChange={(envOrder) => update({ envOrder })} />
      </Row>
      <Row label={tx("分支关系虚线")} description={tx("在卡片之间画出分出、合并的关系")}>
        <Switch label={tx("分支关系虚线")} checked={settings.showLinks} onChange={(showLinks) => update({ showLinks })} />
      </Row>
    </Group>
  </section>;
}

function SlotRow({ at, rule, theme, project, hidden, onChange, onHighlight }: {
  at: number; rule: SlotRule; theme: ThemeColors; project?: LanesSettingsProject; hidden: boolean;
  onChange: (rule: SlotRule) => void;
  onHighlight: (at: number | null) => void;
}) {
  const label = tf("第 {0} 个卡片", at + 1);
  return <div className="gk-setting-row gk-lanes-slot-row" data-hidden={hidden || undefined}
    onMouseEnter={() => onHighlight(hidden ? null : at)} onMouseLeave={() => onHighlight(null)}>
    <div className="gk-setting-copy">
      <strong>{label}</strong>
      <p>{hidden ? tx("超出「最多显示几个卡片」，当前不显示") : ruleHint(rule, project)}</p>
    </div>
    <div className="gk-lanes-slot-controls">
      <div className="gk-lanes-settings-select">
        <BranchSelect theme={theme} aria-label={label} value={rule.kind} options={RULE_KINDS}
          labelFor={(kind) => ruleLabel(kind as RuleKind)}
          onChange={(kind) => onChange(kind === "named"
            ? { kind: "named", names: rule.kind === "named" ? rule.names : [] }
            : { kind: kind as Exclude<RuleKind, "named"> })} />
      </div>
      {rule.kind === "named" && <ListInput label={tf("{0}：分支名", label)} value={rule.names}
        placeholder="test, pre, dev" autoFocus={!rule.names.length}
        onChange={(names) => onChange({ kind: "named", names })} />}
    </div>
  </div>;
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return <section className="gk-settings-group"><h3>{title}</h3><div className="gk-settings-sheet">{children}</div></section>;
}

function Row({ label, description, children }: { label: string; description?: ReactNode; children: ReactNode }) {
  return <div className="gk-setting-row">
    <div className="gk-setting-copy"><strong>{label}</strong>{description && <p>{description}</p>}</div>
    {children}
  </div>;
}

function Switch({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return <button type="button" className="gk-settings-switch" role="switch" aria-label={label}
    aria-checked={checked} onClick={() => onChange(!checked)}><span /></button>;
}

function Segment<T extends number>({ value, options, onChange }: {
  value: T; options: { value: T; label: string }[]; onChange: (v: T) => void;
}) {
  return <div className="gk-settings-segment" role="group">
    {options.map((o) => <button key={o.value} type="button" aria-pressed={o.value === value}
      onClick={() => onChange(o.value)}>{o.label}</button>)}
  </div>;
}

/** Comma-separated branch names. Keeps the typed text while editing; saves the parsed list. */
function ListInput({ label, value, placeholder, autoFocus, onChange }: {
  label: string; value: string[]; placeholder?: string; autoFocus?: boolean; onChange: (names: string[]) => void;
}) {
  const [text, setText] = useState(value.join(", "));
  return <input className="gk-settings-input gk-lanes-list-input" aria-label={label} value={text} placeholder={placeholder}
    autoFocus={autoFocus} spellCheck={false} autoCapitalize="off" autoCorrect="off"
    onChange={(e) => { setText(e.target.value); onChange(parseBranchList(e.target.value)); }}
    onBlur={() => setText(value.join(", "))} />;
}
