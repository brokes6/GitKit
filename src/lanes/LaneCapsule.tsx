import { memo, useCallback, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { BranchTree } from "./BranchTree";
import type { LaneRole } from "./laneLayout";
import type { StackModel } from "./stackModel";
import { useDismiss } from "./useDismiss";
import { usePresence } from "./usePresence";
import { tx } from "../i18n";

/** The pill at the top of a lane; opens the branch tree to pick what the lane shows. */
export const LaneCapsule = memo(function LaneCapsule({ model, branch, role, index, laneIndex, current, onPick }: {
  model: StackModel; branch: string; role: LaneRole; index: number; laneIndex: (branch: string) => number;
  current?: string; onPick: (branch: string) => void;
}) {
  const [menu, setMenu] = useState(false);
  const capsuleRef = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const presence = usePresence(menu, popRef);
  const close = useCallback(() => setMenu(false), []);
  useDismiss(menu, capsuleRef, close, undefined, trigger);

  return <div className="lk-capsule-wrap" ref={capsuleRef}>
      <button type="button" ref={trigger} className="lk-capsule" data-role={role} aria-expanded={menu} onClick={() => setMenu((v) => !v)}>
        <span className="lk-capsule-index">{index + 1}</span>
        <span className="lk-capsule-name">{branch}</span>
        <ChevronDown size={13} aria-hidden="true" />
      </button>
      {presence.mounted && <div className="lk-popover lk-popover-down" ref={popRef} {...presence.attrs}>
        <BranchTree model={model} laneIndex={laneIndex} highlight={[branch]} current={current}
          onPick={(b) => { setMenu(false); onPick(b); }} title={tx("在此区域显示")} />
      </div>}
  </div>;
});
