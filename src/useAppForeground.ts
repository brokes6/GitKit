import { useEffect, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

const domForeground = () => document.visibilityState === "visible" && document.hasFocus();

/** Native window state controls optional local reads; WebView focus is only a signal. */
export function useAppForeground(): boolean {
  const [foreground, setForeground] = useState(() => !isTauri() && domForeground());
  useEffect(() => {
    let disposed = false;
    if (!isTauri()) {
      const update = () => { if (!disposed) setForeground(domForeground()); };
      window.addEventListener("focus", update);
      window.addEventListener("blur", update);
      document.addEventListener("visibilitychange", update);
      update();
      return () => {
        disposed = true;
        window.removeEventListener("focus", update);
        window.removeEventListener("blur", update);
        document.removeEventListener("visibilitychange", update);
      };
    }

    const nativeWindow = getCurrentWindow();
    const unlisteners = new Set<() => void>();
    let revision = 0;
    let nativeConfirmed = false;
    let reading = false;
    let pending = false;
    const readNative = () => {
      if (disposed || reading || !pending) return;
      pending = false;
      reading = true;
      const readRevision = revision;
      void Promise.all([nativeWindow.isFocused(), nativeWindow.isVisible(), nativeWindow.isMinimized()])
        .then(([focused, visible, minimized]) => {
          if (disposed || revision !== readRevision) return;
          nativeConfirmed = true;
          // WKWebView can report hidden while its NSWindow is focused and visible.
          setForeground(focused && visible && !minimized);
        }, () => {
          if (!disposed && revision === readRevision && !nativeConfirmed) setForeground(domForeground());
        })
        .finally(() => { reading = false; readNative(); });
    };
    const calibrate = () => {
      if (disposed) return;
      ++revision;
      pending = true;
      readNative();
    };
    const retain = (promise: Promise<() => void>) => promise.then((stop) => {
      if (disposed) stop();
      else unlisteners.add(stop);
    });

    // DOM events request a fresh native snapshot; they cannot overwrite it.
    window.addEventListener("focus", calibrate);
    window.addEventListener("blur", calibrate);
    document.addEventListener("visibilitychange", calibrate);
    void Promise.allSettled([
      retain(nativeWindow.onFocusChanged(({ payload }) => {
        if (disposed) return;
        if (payload) calibrate();
        else {
          ++revision;
          pending = false;
          nativeConfirmed = true;
          setForeground(false);
        }
      })),
      retain(nativeWindow.onResized(calibrate)),
    ]).then(calibrate);
    return () => {
      disposed = true;
      pending = false;
      for (const stop of unlisteners) stop();
      document.removeEventListener("visibilitychange", calibrate);
      window.removeEventListener("focus", calibrate);
      window.removeEventListener("blur", calibrate);
    };
  }, []);
  return foreground;
}
