import { toast as sonner, type ExternalToast } from "sonner";

// Sonner's default is 4s for everything. Failures and warnings carry detail the
// user needs to read (and often act on), so they stay longer; confirmations go
// quickly. Hovering a toast pauses its timer (sonner default).
const DURATION = { success: 3000, info: 4000, message: 4000, warning: 7000, error: 8000 } as const;
// Reading time for a long description: +1s per ~40 characters, capped.
const READING_MS_PER_CHAR = 25;
const MAX_DURATION = 15000;

function durationFor(kind: keyof typeof DURATION, title: unknown, data?: ExternalToast): number {
  if (data?.duration !== undefined) return data.duration;
  const text = (typeof title === "string" ? title.length : 0)
    + (typeof data?.description === "string" ? data.description.length : 0);
  return Math.min(MAX_DURATION, Math.max(DURATION[kind], text * READING_MS_PER_CHAR + 2000));
}

// An action button means the user may want to click it: don't dismiss it quickly.
function withDefaults(kind: keyof typeof DURATION, title: Parameters<typeof sonner>[0], data?: ExternalToast) {
  const duration = durationFor(kind, title, data);
  return { ...data, duration: data?.action ? Math.max(duration, 10000) : duration };
}

type Message = Parameters<typeof sonner>[0];

function base(message: Message, data?: ExternalToast) {
  return sonner(message, withDefaults("message", message, data));
}

/** Drop-in for sonner's `toast` with per-kind default durations. */
export const toast = Object.assign(base, {
  success: (message: Message, data?: ExternalToast) => sonner.success(message, withDefaults("success", message, data)),
  info: (message: Message, data?: ExternalToast) => sonner.info(message, withDefaults("info", message, data)),
  warning: (message: Message, data?: ExternalToast) => sonner.warning(message, withDefaults("warning", message, data)),
  error: (message: Message, data?: ExternalToast) => sonner.error(message, withDefaults("error", message, data)),
  message: (message: Message, data?: ExternalToast) => sonner.message(message, withDefaults("message", message, data)),
  // A loading toast is replaced by its outcome (same id), which then gets its own duration.
  loading: sonner.loading,
  dismiss: sonner.dismiss,
});
