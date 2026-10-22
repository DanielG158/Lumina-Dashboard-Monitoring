import type { ReactNode } from "react";

/** Lumina mark: a sun-like burst on an accent gradient. */
export function LuminaMark({ size = 30 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" style={{ flex: "none" }}>
      <defs>
        <linearGradient id="lumina-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" style={{ stopColor: "var(--accent)" }} />
          <stop offset="1" stopColor="#8a5cff" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill="url(#lumina-g)" />
      <circle cx="16" cy="16" r="5" fill="#fff" />
      <g stroke="#fff" strokeWidth="2" strokeLinecap="round" opacity="0.92">
        <path d="M16 4.8v3M16 24.2v3M4.8 16h3M24.2 16h3M8.1 8.1l2.1 2.1M21.8 21.8l2.1 2.1M8.1 23.9l2.1-2.1M21.8 10.2l2.1-2.1" />
      </g>
    </svg>
  );
}

const PATHS: Record<string, ReactNode> = {
  proxmox: (<><path d="M12 3 3 8l9 5 9-5-9-5Z" /><path d="m3 12 9 5 9-5" /><path d="m3 16 9 5 9-5" /></>),
  ilo4: (<><rect x="3" y="4" width="18" height="7" rx="2" /><rect x="3" y="13" width="18" height="7" rx="2" /><path d="M7 7.5h.01M7 16.5h.01M12 7.5h5M12 16.5h5" /></>),
  apcupsd: (<><rect x="2.5" y="7" width="16" height="10" rx="2" /><path d="M21.5 10.5v3" /><path d="m11 8-2.5 4.5h3L10 16" /></>),
  "uptime-kuma": <path d="M3 12h4l2.5-6 4 12 2.5-6H21" />,
  cloudflare: <path d="M7 18a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 9.5a4 4 0 0 1-.5 8.5H7Z" />,
  lumina: (<><circle cx="12" cy="12" r="3.5" /><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1" /></>),
  bell: (<><path d="M6 9a6 6 0 1 1 12 0c0 6 2.5 7.5 2.5 7.5h-17S6 15 6 9Z" /><path d="M10 20a2 2 0 0 0 4 0" /></>),
  cpu: (<><rect x="6" y="6" width="12" height="12" rx="2" /><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3" /></>),
  bolt: <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z" />,
  disk: (<><ellipse cx="12" cy="6" rx="8" ry="3" /><path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6" /><path d="M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" /></>),
  screen: (<><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></>),
  cube: (<><path d="M12 3 4 7.5v9L12 21l8-4.5v-9L12 3Z" /><path d="m4 7.5 8 4.5 8-4.5M12 12v9" /></>),
  default: (<><rect x="4" y="4" width="16" height="16" rx="3" /><path d="M9 12h6" /></>),
};

export function Icon({ name, size = 16 }: { name: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flex: "none" }}>
      {PATHS[name] ?? PATHS.default}
    </svg>
  );
}

/** Coloured tile with the module's glyph. */
export function ModuleIcon({ moduleId, size = 34 }: { moduleId: string; size?: number }) {
  return (
    <span className="mod-icon" data-module={moduleId} style={{ width: size, height: size }}>
      <Icon name={moduleId in PATHS ? moduleId : "default"} size={Math.round(size * 0.58)} />
    </span>
  );
}
