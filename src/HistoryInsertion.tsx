import { Component, createRef, type ReactNode, type RefObject } from "react";

interface Props {
  commits: readonly { fullHash: string }[];
  scope: string;
  viewport: RefObject<HTMLDivElement>;
  className: string;
  children: ReactNode;
}

interface Anchor {
  hash: string;
  top: number;
  atTop: boolean;
  inserted: number;
}

// Capture the visible row before React inserts DOM nodes. Measuring both sides
// also accounts for the old HEAD losing a badge and changing its row height.
export class HistoryInsertion extends Component<Props, {}, Anchor | null> {
  private root = createRef<HTMLDivElement>();
  private animations: Animation[] = [];

  getSnapshotBeforeUpdate(previous: Props): Anchor | null {
    const { commits, scope, viewport } = this.props;
    const oldFirst = previous.commits[0]?.fullHash;
    if (scope !== previous.scope || !oldFirst || !commits.length || commits[0].fullHash === oldFirst) return null;
    const inserted = commits.findIndex(commit => commit.fullHash === oldFirst);
    if (inserted < 1) return null;
    const added = new Set(commits.slice(0, inserted).map(commit => commit.fullHash));
    if (previous.commits.some(commit => added.has(commit.fullHash))) return null;

    const list = this.root.current?.querySelector(".gk-commit-glide");
    const view = viewport.current;
    const first = list?.querySelector<HTMLElement>("[data-commit-hash]");
    if (!view || !list || !first) return null;
    const atTop = view.scrollTop <= 1;
    let row = first;
    if (!atTop) {
      const top = view.getBoundingClientRect().top;
      // The glide highlight precedes the rows. Binary search keeps a refresh
      // near the bottom of a long history from measuring every loaded commit.
      let low = 1, high = list.children.length - 1;
      while (low < high) {
        const mid = (low + high) >>> 1;
        if (list.children[mid].getBoundingClientRect().bottom <= top) low = mid + 1;
        else high = mid;
      }
      row = list.children[low] as HTMLElement;
    }
    return { hash: row.dataset.commitHash!, top: row.getBoundingClientRect().top, atTop, inserted };
  }

  componentDidUpdate(_previous: Props, _state: {}, anchor: Anchor | null) {
    if (!anchor) return;
    this.cancelAnimations();
    const view = this.props.viewport.current;
    const list = this.root.current?.querySelector<HTMLElement>(".gk-commit-glide");
    const row = list?.querySelector<HTMLElement>(`[data-commit-hash="${CSS.escape(anchor.hash)}"]`);
    if (!view || !list || !row) return;
    if (!anchor.atTop) {
      view.scrollTop += row.getBoundingClientRect().top - anchor.top;
      return;
    }
    view.scrollTop = 0;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const distance = Math.min(view.clientHeight, row.getBoundingClientRect().top - anchor.top);
    if (distance <= 0) return;
    const timing = { duration: 240, easing: "cubic-bezier(.2,.75,.25,1)" };
    this.animations.push(list.animate([
      { transform: `translateY(-${distance}px)` }, { transform: "translateY(0)" },
    ], timing));
    for (let i = 1; i <= anchor.inserted; i++) {
      const added = list.children[i] as HTMLElement;
      if (added.offsetTop >= view.clientHeight) break;
      this.animations.push(added.animate([{ opacity: 0 }, { opacity: 1 }], timing));
    }
  }

  private cancelAnimations() {
    for (const animation of this.animations) animation.cancel();
    this.animations = [];
  }

  componentWillUnmount() { this.cancelAnimations(); }

  render() {
    return <div ref={this.root} className={this.props.className}>{this.props.children}</div>;
  }
}
