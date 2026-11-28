import { useEffect, useMemo, useRef, useState } from "react";
import { Toaster, toast } from "sonner";
import { Columns3 } from "lucide-react";
import { createDemoRepo } from "./demoRepo";
import type { DemoRepo } from "./demoRepo";
import { LanesWorkspace, leaveLanes } from "./LanesWorkspace";
import type { LaneProjectRef } from "./LanesWorkspace";
import type { LaneWorkingFile } from "./types";
import { tx } from "../i18n";

// Browser-only host for the lanes workspace (`npm run dev` + `?shell=lanes`).
// Inside Tauri the full app hosts the workspace instead, with real data,
// dialogs and settings.

const DEMO_PROJECT: LaneProjectRef = { id: "demo", name: "gitkit-demo", path: "demo" };
const DEMO_WORKING: LaneWorkingFile[] = [
  { path: "src/lanes/LanesWorkspace.tsx", status: "modified", staged: false },
  { path: "src/lanes/laneLayout.ts", status: "added", staged: true },
  { path: "src/lanes/lanes.css", status: "modified", staged: true },
  { path: "docs/lanes.md", status: "untracked", staged: false },
];

function useThemeAttr(): "dark" | "light" {
  const mode = localStorage.getItem("gitkit.themeMode") ?? "dark";
  const [systemDark, setSystemDark] = useState(() => matchMedia("(prefers-color-scheme: dark)").matches);
  useEffect(() => {
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const on = () => setSystemDark(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return mode === "system" ? (systemDark ? "dark" : "light") : mode === "light" ? "light" : "dark";
}

export default function LanesApp() {
  const theme = useThemeAttr();
  const demo = useRef<DemoRepo>(createDemoRepo());
  const [tick, setTick] = useState(0);
  const branches = useMemo(() => [...demo.current.branches], [tick]);
  const onlyInApp = () => toast(tx("演示模式下不可用，请在 GitKit 应用中使用"));

  return <>
    <LanesWorkspace theme={theme} demo project={DEMO_PROJECT} projects={[DEMO_PROJECT]} status="ready"
      branches={branches} commits={demo.current.commits} changes={DEMO_WORKING.length} working={DEMO_WORKING}
      onSelectProject={() => {}} onOpenProject={onlyInApp}
      onCreateBranch={async (name, base) => {
        const head = demo.current.branches.find((b) => b.name === base && !b.isRemote)?.head;
        if (!head) throw new Error(tx("找不到基础分支"));
        demo.current.branches.push({ name, head, current: false, ahead: 0, behind: 0 });
        setTick((n) => n + 1);
      }}
      onCheckout={(branch) => {
        demo.current.branches.forEach((b) => { b.current = b.name === branch; });
        setTick((n) => n + 1);
      }}
      onFetch={onlyInApp} onPull={onlyInApp} onPush={onlyInApp}
      onOpenChanges={onlyInApp} onOpenCommit={onlyInApp} onOpenSettings={onlyInApp}
      moreActions={[{ label: tx("回到经典界面"), icon: <Columns3 size={14} aria-hidden="true" />, onClick: leaveLanes }]} />
    <Toaster position="top-center" theme={theme} />
  </>;
}
