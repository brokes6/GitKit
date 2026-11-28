import { lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { isTauri } from "@tauri-apps/api/core";
import "@fontsource-variable/manrope/wght.css";
import "@fontsource-variable/sora/wght.css";
import "./styles/index.css";
import { disableAutoText } from "./disableAutoText.ts";

disableAutoText();

// The native host supplies Git data. A plain browser uses the demo repository.
const Workspace = lazy(() => isTauri() ? import("./App.tsx") : import("./lanes/LanesApp.tsx"));
createRoot(document.getElementById("root")!).render(<Suspense fallback={null}><Workspace /></Suspense>);
