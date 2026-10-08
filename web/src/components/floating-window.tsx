import { createContext, useContext, useEffect, useId, useRef, useState } from "react";
import type { ReactNode, PointerEvent as ReactPointerEvent } from "react";

export interface FloatingWindowPosition {
  horizontal: "left" | "right";
  vertical: "top" | "bottom";
  offsetX: number;
  offsetY: number;
}
interface Panel { id: string; position: FloatingWindowPosition; collapsed: boolean; undocked: boolean; }
interface Frame { width: number; height: number; top: number; bottom: number; }
const LayoutContext = createContext<{
  frame: Frame; panels: Panel[]; register: (panel: Panel) => void; unregister: (id: string) => void;
} | null>(null);

export function FloatingWindowLayout({ children }: { children: ReactNode }) {
  const [panels, setPanels] = useState<Panel[]>([]);
  const [frame, setFrame] = useState<Frame>({ width: window.innerWidth, height: window.innerHeight, top: 112, bottom: 72 });
  const register = useRef((panel: Panel) => setPanels((current) => [...current.filter((item) => item.id !== panel.id), panel]));
  const unregister = useRef((id: string) => setPanels((current) => current.filter((item) => item.id !== id)));
  useEffect(() => {
    function measure() {
      const header = document.querySelector(".top-toolbar-overlay, .preview-window-toolbar");
      const footer = document.querySelector(".status-line-overlay");
      const height = window.innerHeight;
      const next = { width: window.innerWidth, height,
        top: Math.max(12, (header?.getBoundingClientRect().bottom ?? 0) + 10),
        bottom: Math.max(12, footer ? height - footer.getBoundingClientRect().top + 10 : 12),
      };
      setFrame((current) => JSON.stringify(current) === JSON.stringify(next) ? current : next);
    }
    const observer = new ResizeObserver(measure);
    document.querySelectorAll(".top-toolbar-overlay, .preview-window-toolbar, .status-line-overlay").forEach((element) => observer.observe(element));
    const mutations = new MutationObserver(measure);
    mutations.observe(document.querySelector("main") ?? document.body, { childList: true });
    window.addEventListener("resize", measure);
    window.addEventListener("orientationchange", measure);
    measure();
    return () => { observer.disconnect(); mutations.disconnect(); window.removeEventListener("resize", measure); window.removeEventListener("orientationchange", measure); };
  }, []);
  return <LayoutContext.Provider value={{ frame, panels, register: register.current, unregister: unregister.current }}>{children}</LayoutContext.Provider>;
}

interface FloatingWindowProps {
  title: string; kicker?: string; position: FloatingWindowPosition; width?: number;
  children: ReactNode; onPositionChange: (position: FloatingWindowPosition) => void;
}

export function FloatingWindow({ title, kicker, position, width = 320, children, onPositionChange }: FloatingWindowProps) {
  const layout = useContext(LayoutContext);
  const id = useId();
  const elementRef = useRef<HTMLElement>(null);
  const cleanupDragRef = useRef<(() => void) | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [undocked, setUndocked] = useState(false);
  const viewport = layout?.frame ?? { width: window.innerWidth, height: window.innerHeight, top: 112, bottom: 72 };
  const container = elementRef.current?.offsetParent?.getBoundingClientRect();
  const frame = container ? {
    width: container.width, height: container.height,
    top: Math.max(12, viewport.top - container.top),
    bottom: Math.max(12, viewport.bottom - (viewport.height - container.bottom)),
  } : viewport;
  const compact = frame.width < 1480 || frame.height < 850;
  useEffect(() => { layout?.register({ id, position, collapsed, undocked }); }, [layout?.register, id, position, collapsed, undocked]);
  useEffect(() => () => { layout?.unregister(id); cleanupDragRef.current?.(); }, [layout?.unregister, id]);
  useEffect(() => {
    function reset() { setUndocked(false); setCollapsed(false); }
    window.addEventListener("wawod-reset-panels", reset);
    return () => window.removeEventListener("wawod-reset-panels", reset);
  }, []);
  const availableHeight = Math.max(64, frame.height - frame.top - frame.bottom);
  const resolvedWidth = Math.min(width, compact ? Math.max(200, Math.min(300, frame.width * 0.31)) : width, Math.max(120, frame.width - 24));
  let x = Math.max(12, Math.min(position.offsetX, frame.width - resolvedWidth - 12));
  let y = position.vertical === "top" ? position.offsetY : frame.height - position.offsetY - Math.min(availableHeight, elementRef.current?.offsetHeight ?? 180);
  let maxHeight = availableHeight;
  if (compact && !undocked) {
    const peers = (layout?.panels ?? []).filter((panel) => !panel.undocked && panel.position.horizontal === position.horizontal)
      .sort((a, b) => (a.position.vertical === "top" ? a.position.offsetY : frame.height - a.position.offsetY) - (b.position.vertical === "top" ? b.position.offsetY : frame.height - b.position.offsetY) || a.id.localeCompare(b.id));
    const expanded = peers.filter((panel) => !panel.collapsed).length;
    const slot = Math.max(56, (availableHeight - Math.max(0, peers.length - 1) * 8 - (peers.length - expanded) * 56) / Math.max(1, expanded));
    const index = Math.max(0, peers.findIndex((panel) => panel.id === id));
    y = frame.top + peers.slice(0, index).reduce((sum, panel) => sum + (panel.collapsed ? 56 : slot) + 8, 0);
    x = 12;
    maxHeight = collapsed ? 56 : slot;
  } else {
    y = Math.max(frame.top, Math.min(y, frame.height - frame.bottom - Math.min(180, availableHeight)));
    maxHeight = frame.height - frame.bottom - y;
  }
  function handlePointerDown(event: ReactPointerEvent<HTMLElement>) {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button, input, select, textarea, label")) return;
    event.preventDefault();
    cleanupDragRef.current?.();
    const rect = elementRef.current!.getBoundingClientRect();
    const originX = container?.left ?? 0, originY = container?.top ?? 0;
    const startX = position.horizontal === "left" ? rect.left - originX : frame.width - rect.right + originX;
    const startY = position.vertical === "top" ? rect.top - originY : frame.height - rect.bottom + originY;
    const pointerId = event.pointerId, clientX = event.clientX, clientY = event.clientY;
    setUndocked(true);
    onPositionChange({ ...position, offsetX: startX, offsetY: startY });
    function move(next: PointerEvent) {
      if (next.pointerId !== pointerId) return;
      onPositionChange({ ...position,
        offsetX: startX + (next.clientX - clientX) * (position.horizontal === "left" ? 1 : -1),
        offsetY: startY + (next.clientY - clientY) * (position.vertical === "top" ? 1 : -1),
      });
    }
    function end(next: PointerEvent) { if (next.pointerId === pointerId) cleanupDragRef.current?.(); }
    cleanupDragRef.current = () => {
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", end); window.removeEventListener("pointercancel", end);
      cleanupDragRef.current = null;
    };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", end); window.addEventListener("pointercancel", end);
  }
  return <section ref={elementRef} data-floating-panel={title} className={`floating-window${collapsed ? " is-collapsed" : ""}`}
    style={{ width: resolvedWidth, maxHeight, [position.horizontal]: x, top: y }}>
    <header className="floating-window-header" onPointerDown={handlePointerDown}>
      <div>{kicker ? <p className="section-kicker">{kicker}</p> : null}<h2>{title}</h2></div>
      <button type="button" className="floating-window-collapse" aria-label={`${collapsed ? "Expand" : "Collapse"} ${title}`} aria-expanded={!collapsed} onClick={() => setCollapsed(!collapsed)}>{collapsed ? "+" : "-"}</button>
    </header>
    {!collapsed ? <div className="floating-window-body">{children}</div> : null}
  </section>;
}
