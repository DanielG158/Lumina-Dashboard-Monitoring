import type { ReactNode } from "react";

/** Lumina mark: a sun-like burst on an accent gradient. */
export function LuminaMark({ size = 30 }: { size?: number }) {
  // The Lumina mark: a navy gate holding rising bars of light. Drawn at 548 x 648; `size` is the height.
  return (
    <svg height={size} width={(size * 548) / 648} viewBox="0 0 548 648" aria-hidden="true" style={{ flex: "none" }}>
      <polygon fill="var(--mark-gate, #3a5096)" points="274,169 345,210 345,323 274,283 151,356 149,644 3,644 3,611 51,611 51,302" />
      <rect fill="#f49437" x="306" y="414" width="39" height="230" /><rect fill="#f49437" x="241" y="494" width="39" height="150" /><rect fill="#f49437" x="175" y="558" width="39" height="86" />
      <polygon fill="#fab14c" points="370,127 409,102 409,644 370,644" />
      <polygon fill="#fab14c" points="435,25 473,2 473,286 496,302 496,612 544,612 544,644 435,644" />
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
  netcheck: (<><path d="M5 12.5a10 10 0 0 1 14 0" /><path d="M8 15.5a6 6 0 0 1 8 0" /><path d="M11 18.5a2 2 0 0 1 2 0" /><circle cx="12" cy="20" r=".5" /></>),
  snmp: (<><rect x="3" y="8" width="18" height="8" rx="2" /><path d="M7 12h.01M11 12h.01M15 12h.01M19 12h.01" /><path d="M6 8V5M12 8V5M18 8V5" /></>),
  omada: (<><path d="M5 10a10 10 0 0 1 14 0" /><path d="M8 13a6 6 0 0 1 8 0" /><circle cx="12" cy="16.5" r="1.2" /><rect x="8" y="19" width="8" height="2" rx="1" /></>),
  "tplink-router": (<><rect x="3" y="12" width="18" height="7" rx="2" /><path d="M7 16h.01M11 16h.01" /><path d="M8 12V6M16 12V6" /><path d="M5.5 4.5a3.5 3.5 0 0 1 5 0M13.5 4.5a3.5 3.5 0 0 1 5 0" /></>),
  "ilo-snmp": (<><rect x="3" y="4" width="18" height="7" rx="2" /><rect x="3" y="13" width="18" height="7" rx="2" /><path d="M7 7.5h.01M7 16.5h.01M12 7.5h5M12 16.5h5" /></>),
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
