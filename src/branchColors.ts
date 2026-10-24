export type BranchColors = ReadonlyMap<string, string>;

interface ColorBranch {
  name: string;
  remote?: string;
  isRemote?: boolean;
  current?: boolean;
}

type RGB = readonly [number, number, number];
const NEUTRAL = "#8A857C";

function nameHash(name: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) hash = Math.imul(hash ^ name.charCodeAt(i), 0x01000193);
  hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b);
  return (hash ^ (hash >>> 13)) >>> 0;
}

function hslRGB(hue: number, saturation: number, lightness: number): RGB {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const x = chroma * (1 - Math.abs((hue / 60) % 2 - 1));
  const offset = lightness - chroma / 2;
  const components: RGB = hue < 60 ? [chroma, x, 0] : hue < 120 ? [x, chroma, 0]
    : hue < 180 ? [0, chroma, x] : hue < 240 ? [0, x, chroma]
      : hue < 300 ? [x, 0, chroma] : [chroma, 0, x];
  return [components[0] + offset, components[1] + offset, components[2] + offset];
}

function luminance(rgb: RGB): number {
  const linear = rgb.map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}

function generatedColor(name: string, rotation = 0): string {
  const hash = nameHash(name);
  const hue = (hash / 0x100000000 * 360 + rotation * 137.507764) % 360;
  const saturation = 0.34 + ((hash >>> 8) & 255) / 255 * 0.18;
  // Match brightness across hues so yellow stays readable on light surfaces
  // and blue remains visible on dark surfaces. Return hex for existing alpha suffixes.
  let low = 0, high = 1;
  for (let step = 0; step < 12; step++) {
    const middle = (low + high) / 2;
    if (luminance(hslRGB(hue, saturation, middle)) < 0.22) low = middle;
    else high = middle;
  }
  return "#" + hslRGB(hue, saturation, (low + high) / 2)
    .map(value => Math.round(value * 255).toString(16).padStart(2, "0")).join("");
}

function rgbOf(hex: string): RGB {
  return [Number.parseInt(hex.slice(1, 3), 16), Number.parseInt(hex.slice(3, 5), 16), Number.parseInt(hex.slice(5, 7), 16)];
}

function nextColor(name: string, assigned: readonly RGB[]): string {
  let best = generatedColor(name), bestDistance = -1;
  for (let rotation = 0; rotation < 32; rotation++) {
    const color = rotation === 0 ? best : generatedColor(name, rotation);
    const rgb = rgbOf(color);
    const distance = assigned.reduce((minimum, other) => Math.min(minimum,
      rgb.reduce((sum, value, channel) => sum + (value - other[channel]) ** 2, 0)), Infinity);
    if (distance > bestDistance) { best = color; bestDistance = distance; }
    if (rotation === 0 && distance >= 60 ** 2) break;
  }
  return best;
}

/** A deterministic fallback also covers branch names absent from a snapshot. */
export function branchColor(name: string, colors?: BranchColors): string {
  return name ? colors?.get(name) ?? generatedColor(name) : NEUTRAL;
}

/** Build one immutable snapshot per repository. Retain existing assignments
 * across refreshes; visible locals get the first choices on an initial load. */
export function createBranchColors(
  branches: readonly ColorBranch[], previous?: BranchColors, preferredNames: readonly string[] = [],
): BranchColors {
  const aliases = new Map<string, string>();
  const locals = branches.filter(branch => !branch.isRemote)
    .sort((a, b) => Number(!!b.current) - Number(!!a.current));
  for (const branch of locals) {
    if (branch.remote && !aliases.has(branch.remote)) aliases.set(branch.remote, branch.name);
  }
  const preferred = new Set(preferredNames);
  const names = [...new Set(branches.map(branch => branch.isRemote
    ? aliases.get(branch.name) ?? branch.name : branch.name).filter(Boolean))]
    .sort((a, b) => Number(preferred.has(b)) - Number(preferred.has(a)) || (a < b ? -1 : a > b ? 1 : 0));
  const colors = new Map<string, string>();
  const used = new Set<string>();
  for (const name of names) {
    const color = previous?.get(name);
    if (color && !used.has(color)) { colors.set(name, color); used.add(color); }
  }
  const assigned = [...used].map(rgbOf);
  for (const name of names) {
    if (colors.has(name)) continue;
    const color = nextColor(name, assigned);
    colors.set(name, color);
    assigned.push(rgbOf(color));
  }
  for (const [alias, name] of aliases) {
    const color = colors.get(name);
    if (color) colors.set(alias, color);
  }
  return colors;
}
