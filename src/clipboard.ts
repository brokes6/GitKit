import { toast } from "./toast";
import { tf, tx } from "./i18n";

/** Copy text and tell the user the outcome (context-menu items have no inline state). */
export async function copyWithToast(text: string, what: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(tf("已复制{0}", what), { description: text.length <= 80 ? text : undefined, duration: 2000 });
  } catch {
    toast.error(tx("无法复制到剪贴板"));
  }
}
