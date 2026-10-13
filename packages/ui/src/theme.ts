export interface ThemeDef {
  id: string;
  name: string;
  swatch: [string, string, string];
}

export const THEMES: ThemeDef[] = [
  { id: "dark", name: "Dark", swatch: ["#0b0d12", "#13161e", "#7c9cff"] },
  { id: "light", name: "Light", swatch: ["#f4f6fb", "#ffffff", "#3b6cf6"] },
  { id: "catppuccin", name: "Catppuccin", swatch: ["#1e1e2e", "#313244", "#cba6f7"] },
  { id: "nord", name: "Nord", swatch: ["#2e3440", "#3b4252", "#88c0d0"] },
];

const KEY_THEME = "lumina:theme";
const KEY_ACCENT = "lumina:accent";

function read(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function write(key: string, value: string | null) {
  try { value === null ? localStorage.removeItem(key) : localStorage.setItem(key, value); } catch { /* storage unavailable */ }
}

export function getTheme(): string {
  const t = read(KEY_THEME);
  return THEMES.some((x) => x.id === t) ? (t as string) : "dark";
}
export function getAccent(): string | null {
  const a = read(KEY_ACCENT);
  return a && /^#[0-9a-fA-F]{6}$/.test(a) ? a : null;
}

export function applyTheme(theme = getTheme(), accent = getAccent()) {
  const root = document.documentElement;
  root.dataset.theme = theme;
  if (accent) root.style.setProperty("--accent", accent);
  else root.style.removeProperty("--accent");
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", getComputedStyle(root).getPropertyValue("--bg").trim() || "#0b0d12");
}

export function setTheme(theme: string) {
  write(KEY_THEME, theme);
  applyTheme(theme, getAccent());
}
export function setAccent(accent: string | null) {
  write(KEY_ACCENT, accent);
  applyTheme(getTheme(), accent);
}

// ---- display protection (burn-in) preferences, per browser ----
export type ShuffleMode = "off" | "tv" | "always";
const KEY_SHUFFLE = "lumina:shuffle";
const KEY_SHUFFLE_SECONDS = "lumina:shuffle-seconds";

export function getShuffleMode(): ShuffleMode {
  const v = read(KEY_SHUFFLE);
  return v === "off" || v === "always" ? v : "tv";
}
export function getShuffleSeconds(): number {
  const n = Number(read(KEY_SHUFFLE_SECONDS));
  return [10, 15, 30, 60].includes(n) ? n : 15;
}
export function setShuffle(mode: ShuffleMode, seconds: number) {
  write(KEY_SHUFFLE, mode);
  write(KEY_SHUFFLE_SECONDS, String(seconds));
  window.dispatchEvent(new Event("lumina:display"));
}
