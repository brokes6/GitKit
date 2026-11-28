import { lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { isTauri } from "@tauri-apps/api/core";
import "@fontsource-variable/manrope/wght.css";
import "@fontsource-variable/sora/wght.css";
import App from "./App.tsx";
import "./styles/index.css";
import { disableAutoText } from "./disableAutoText.ts";

disableAutoText();

// `?shell=lanes` (or the toggle in either UI) switches to the experimental
// branch-lanes workspace; the choice is remembered across launches.
const LanesApp = lazy(() => import("./lanes/LanesApp.tsx"));
const requested = new URLSearchParams(location.search).get("shell");
if (requested === "lanes" || requested === "classic") localStorage.setItem("gitkit.shell", requested);
const shell = localStorage.getItem("gitkit.shell");

// In Tauri the full app hosts the lanes shell (real data, dialogs, settings);
// a plain browser has no backend, so it gets the demo host instead.
createRoot(document.getElementById("root")!).render(shell === "lanes" && !isTauri()
  ? <Suspense fallback={null}><LanesApp /></Suspense>
  : <App />);
