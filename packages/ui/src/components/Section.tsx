import { useState, type ReactNode } from "react";

function useCollapsed(key: string, initial: boolean): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      const v = localStorage.getItem(key);
      return v === null ? initial : v === "1";
    } catch {
      return initial;
    }
  });
  return [
    collapsed,
    () => setCollapsed((c) => {
      try { localStorage.setItem(key, c ? "0" : "1"); } catch { /* storage unavailable */ }
      return !c;
    }),
  ];
}

interface Props {
  id: string;
  title: string;
  count?: number;
  meta?: string;
  defaultCollapsed?: boolean;
  children: ReactNode;
}

export function Section({ id, title, count, meta, defaultCollapsed = false, children }: Props) {
  const [collapsed, toggle] = useCollapsed(`lumina:section:${id}`, defaultCollapsed);
  return (
    <div className="section">
      <button className="section-head" onClick={toggle} aria-expanded={!collapsed}>
        <span className="chevron">{collapsed ? "▸" : "▾"}</span>
        <span className="section-title">{title}</span>
        {count !== undefined && <span className="tag">{count}</span>}
        {meta && <span className="meta">{meta}</span>}
      </button>
      {!collapsed && <div className="table-wrap">{children}</div>}
    </div>
  );
}
