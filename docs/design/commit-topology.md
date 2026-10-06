# Commit topology

The commit-history header switches between List and Topology. List remains the
initial default; the selected mode persists in `gitkit.historyMode`. Both modes
respect the sidebar's hidden branches and focused branch.

Topology shows the real loaded Git objects from older to newer, left to right.
It uses the existing branch lane calculation and branch colors. Every edge
connects exact full hashes from a commit's parent list. Missing parents at a
history/filter boundary remain disconnected; the footer explains that boundary.
The current history loader retains its 400-commit window. Smart Merge remains a
list presentation setting and does not collapse independent topology nodes.

Drag the canvas in either axis or scroll with the trackpad. Arrow keys pan when
the canvas has keyboard focus. Nodes can be reached with Tab and activated with
Enter or Space. Zoom controls and +/- keys preserve the viewport center; Fit
centers the complete loaded graph, including scales below 1% for long histories.
At overview scale, compact SVG markers keep nodes visible while labels recede.
Selection uses a theme-accent outer ring and a bordered, tinted hash/title label
with a check mark. Its opaque base keeps crossing edges behind the label. Hover
and branch highlights use a thinner branch-color ring; HEAD retains its filled
branch-color core. Overview selection is drawn last with a screen-space ring.
HEAD restores 100% scale at the actual checked-out commit; its locator is disabled
when HEAD is outside the current scope.
Clicking a node reuses the existing commit detail, or stash detail for stash
nodes. Stashes use a square node and dashed connection to their base.

The canvas retains native two-axis scrolling. Edges and overview markers project
directly into a viewport-sized SVG, avoiding a history-wide SVG's paint bounds.
Scrolling synchronizes its viewBox in the DOM without rerendering the graph.

Selection feedback uses one short SVG light segment on the selected commit's
existing, direct parent/child paths, traveling outward from that commit. Lane
colors remain the source of the highlight, and stash light segments retain a
broken-line appearance. A brief outer-ring highlight accompanies the selection;
the static selection, HEAD, merge, and stash markers remain the visual authority.
The feedback starts only when the selected full hash changes. Restoring a
selection on mount, repeating a click, zooming, hovering, resizing, and panning
do not replay it. A new selection cancels the previous animation. Reduced motion
keeps the existing static selection without the light segment or ring animation.

## Direction contract

- THESIS: expose real branch ancestry, forks, and merges as a horizontal diagram
  inside the existing commit-history pane.
- OWN-WORLD: inherit ThemeColors, branchColor, Manrope UI typography, monospace
  hashes, compact controls, and GitKit's light/dark palettes.
- STORY: select the same branch scope, switch view, pan to a relationship, and
  open the same commit detail from its node.
- FIRST VIEWPORT: compact history-mode switch above the diagram; zoom, Fit, and
  HEAD controls at the top; branch refs above nodes and hashes/messages below;
  brief pan instructions and history boundary at the bottom.
- FORM: user-pinned horizontal DAG from the supplied reference. This is an
  extension of the history pane; no concept seed or new visual identity.
- FINISH: reviewer disposition is ship after the Fit, HEAD, and direct SVG
  rendering corrections. The existing code remains visual authority; PRODUCT.md
  and DESIGN.md were absent before this extension and no global design files or
  .impeccable sidecar are created. This scoped brief records the result. The graph
  is vector geometry and ships no raster assets.

## Validation

Layout tests cover octopus merges, reused lanes, disconnected nodes, hidden and
focused history, full-hash identity, truncated/reversed parents, stash base links,
reference spacing, and immutability. Component previews use explicitly synthetic
multi-branch data to verify light/dark rendering, narrow panes, node selection,
drag/click separation, two-axis panning, keyboard panning, zoom, Fit, HEAD, and
English text. They do not establish real Tauri window or repository acceptance.

The finishing pass passed 28 topology, branch-history, Smart Merge, and i18n
tests, TypeScript checking, Vite production build, and `git diff --check`.
Synthetic component fixtures verified 1280×820 light/dark views, 780×600 narrow
views and English Fit, and a 500px canvas fitting 400 linear commits at 0.74%.
Fit retained the complete graph; HEAD restored 100% and was disabled without an
actual HEAD. Graph-scoped branch filters and the list's Smart Merge remain intact.

Screenshot evidence is stored in
`/Users/apple/.codex/visualizations/2026/10/06/01a11183-e713-7fc0-8cf0-88ec9f18b969/`:
`topology-light.jpg`, `topology-dark.jpg`, `topology-narrow.jpg`,
`topology-narrow-fit-english.jpg`, and `topology-long-fit.jpg`. These are synthetic
review captures, not shipping assets. Temporary fixtures and the preview server
were removed. Native Tauri behavior and real-repository branch filtering/detail
overlays were not run; unrelated dirty GitLab MR work is outside this extension.

The selection refinement passed TypeScript checking, the production build, and
visual checks of light/dark merge selection, selected HEAD, and 51% overview.
Clicking a node changed the synthetic preview selection. Selected hash contrast
is 5.43:1 in Blue Light and 7.77:1 in Blue Dark; selected subject contrast is
14.71:1 and 11.95:1 against the composited selection fill. Additional captures
are `topology-selection-light.jpg`, `topology-selection-dark.jpg`,
`topology-selection-head-dark.jpg`, and `topology-selection-overview-dark.jpg`
in the same evidence directory. These checks retain the native-runtime limit
above.
