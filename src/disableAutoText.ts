// WKWebView on macOS auto-capitalizes ("hotfix" -> "Hotfix") and auto-corrects
// text fields by default. Branch names, tags and commit messages are
// case-sensitive, so switch it off for every text control.
const TEXT_SELECTOR = "input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=file]), textarea";

function applyTo(el: Element) {
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return;
  el.setAttribute("autocapitalize", "off");
  el.setAttribute("autocorrect", "off");
  if (!el.hasAttribute("spellcheck")) el.spellcheck = false;
}

export function disableAutoText() {
  const sweep = (root: ParentNode) => root.querySelectorAll(TEXT_SELECTOR).forEach(applyTo);
  sweep(document);
  new MutationObserver((records) => {
    for (const record of records) {
      record.addedNodes.forEach((node) => {
        if (!(node instanceof Element)) return;
        if (node.matches(TEXT_SELECTOR)) applyTo(node);
        sweep(node);
      });
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
}
