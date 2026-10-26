"use client";
/**
 * 팔레트·캔버스·속성 패널의 크기와 표시 상태를 관리한다. 레이아웃 저장값은 사용자 환경설정이며 워크플로 JSON을 변경하지 않는다.
 */


import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { Group, Panel, Separator, type GroupImperativeHandle, type Layout } from "react-resizable-panels";
import { Icon } from "./common";

/** 현재 패널 구성과 정확히 일치하는 백분율만 복원한다. 패널 수나 합계가 맞지 않는 과거 설정은 기본 배치로 돌아간다. */
export function readPanelLayout(text: string | null, ids: string[]): Layout | undefined {
  if (!text) return;
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const layout = value as Layout;
    if (Object.keys(layout).length !== ids.length || !ids.every(id => typeof layout[id] === "number" && Number.isFinite(layout[id]) && layout[id] >= 0 && layout[id] <= 100)) return;
    if (Math.abs(ids.reduce((sum, id) => sum + layout[id], 0) - 100) > .1) return;
    return layout;
  } catch { return; }
}

/** 사용자/편집기별 속성 패널 열림 상태를 저장한다. 저장소 읽기는 클라이언트 렌더링 이후에 수행한다. */
export function useInspectorVisibility(storageKey: string): [boolean, Dispatch<SetStateAction<boolean>>] {
  const [visible, setVisible] = useState(true);
  const preferenceKey = `flowly:panels:v1:${storageKey}:inspector`;
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      try { setVisible(localStorage.getItem(preferenceKey) !== "false"); } catch { /* Optional preference. */ }
    });
    return () => cancelAnimationFrame(frame);
  }, [preferenceKey]);
  const change = useCallback<Dispatch<SetStateAction<boolean>>>(next => {
    setVisible(previous => {
      const value = typeof next === "function" ? next(previous) : next;
      try { localStorage.setItem(preferenceKey, String(value)); } catch { /* Optional preference. */ }
      return value;
    });
  }, [preferenceKey]);
  return [visible, change];
}

/** Presentation state is scoped to the signed-in user; it never changes a workflow. */
/** 화면 폭에 따라 가로 패널과 세로 패널·서랍을 전환한다. 패널 등록 후 저장 배치를 복원하고 사용자 조작으로 바뀐 크기만 보관한다. */
export function Workbench({ palette, inspector, children, storageKey, className = "" }: {
  palette?: ReactNode;
  inspector?: ReactNode;
  children?: ReactNode;
  storageKey: string;
  className?: string;
}) {
  const container = useRef<HTMLDivElement>(null);
  const group = useRef<GroupImperativeHandle | null>(null);
  const panelPrefix = useId();
  const panelIds = { palette: `${panelPrefix}-palette`, canvas: `${panelPrefix}-canvas`, inspector: `${panelPrefix}-inspector` };
  const [compact, setCompact] = useState(false);
  const [paletteHidden, setPaletteHidden] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const showPalette = !!palette && !paletteHidden && !compact;
  const showInspector = !!inspector;
  const config = `${compact ? "stack" : "row"}:${showPalette ? "palette" : "canvas"}:${showInspector ? "inspector" : "wide"}`;
  const preferenceKey = `flowly:panels:v1:${storageKey}`;
  const layoutKey = `${preferenceKey}:${config}`;
  const ids: (keyof typeof panelIds)[] = [...(showPalette ? ["palette" as const] : []), "canvas", ...(showInspector ? ["inspector" as const] : [])];
  const defaults: Layout = compact
    ? (showInspector ? { canvas: 58, inspector: 42 } : { canvas: 100 })
    : showPalette
      ? (showInspector ? { palette: 21, canvas: 49, inspector: 30 } : { palette: 23, canvas: 77 })
      : (showInspector ? { canvas: 68, inspector: 32 } : { canvas: 100 });
  // DOM IDs are unique even with multiple nested editors; stored preferences use stable names.
  const liveLayout = (layout: Layout): Layout => Object.fromEntries(ids.map(id => [panelIds[id], layout[id]]));

  useLayoutEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setCompact(element.clientWidth < 740));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      try { setPaletteHidden(localStorage.getItem(`${preferenceKey}:hidden`) === "true"); } catch { /* Storage can be disabled. */ }
    });
    return () => cancelAnimationFrame(frame);
  }, [preferenceKey]);

  useEffect(() => {
    // Wait for the library to register a changed set of panels before restoring it.
    const frame = requestAnimationFrame(() => {
      let saved: Layout | undefined;
      try { saved = readPanelLayout(localStorage.getItem(layoutKey), ids); } catch { /* Use the current defaults. */ }
      group.current?.setLayout(liveLayout(saved ?? defaults));
    });
    return () => cancelAnimationFrame(frame);
    // These values are fully identified by config and storageKey.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, storageKey]);

  function togglePalette() {
    if (compact) { setDrawer(value => !value); return; }
    setPaletteHidden(value => {
      try { localStorage.setItem(`${preferenceKey}:hidden`, String(!value)); } catch { /* Optional preference. */ }
      return !value;
    });
  }

  return <div ref={container} className={`workbench resizable-workbench ${compact ? "workbench-compact" : ""} ${className}`}>
    <div className="workbench-tools">
      {palette && <button type="button" className="canvas-text-action" aria-expanded={compact ? drawer : showPalette} onClick={togglePalette}>
        <Icon name="layers" size={16}/>{(compact ? drawer : showPalette) ? "블록 목록 접기" : "블록 목록 열기"}
      </button>}
      <span>경계를 끌거나 선택 후 방향키로 공간을 조절하세요.</span>
      <button type="button" className="canvas-text-action" onClick={() => {
        group.current?.setLayout(liveLayout(defaults));
        try { localStorage.removeItem(layoutKey); } catch { /* Optional preference. */ }
      }}>패널 크기 초기화</button>
    </div>
    <Group groupRef={group} orientation={compact ? "vertical" : "horizontal"} className="workbench-panels"
      onLayoutChanged={(layout, meta) => {
        const named = Object.fromEntries(ids.map(id => [id, layout[panelIds[id]]]));
        if (!meta.isUserInteraction || !readPanelLayout(JSON.stringify(named), ids)) return;
        try { localStorage.setItem(layoutKey, JSON.stringify(named)); } catch { /* Optional preference. */ }
      }}>
      {showPalette && <Panel key="palette" id={panelIds.palette} minSize="190px" maxSize="360px" defaultSize="21%" className="workbench-panel palette-panel">{palette}</Panel>}
      {showPalette && <Separator key="palette-handle" className="workbench-resize-handle" aria-label="블록 목록 너비 조절"/>}
      <Panel key="canvas" id={panelIds.canvas} minSize={compact ? "260px" : "240px"} defaultSize={showInspector ? "49%" : "77%"} className="workbench-panel canvas-panel">{children}</Panel>
      {showInspector && <Separator key="inspector-handle" className="workbench-resize-handle" aria-label={compact ? "설정 패널 높이 조절" : "설정 패널 너비 조절"}/>}
      {showInspector && <Panel key="inspector" id={panelIds.inspector} minSize={compact ? "220px" : "280px"} maxSize={compact ? "75%" : "480px"} defaultSize={compact ? "42%" : "30%"} className="workbench-panel inspector-panel">{inspector}</Panel>}
    </Group>
    {compact && palette && drawer && <div className="workbench-palette-drawer">
      <header><strong>블록 추가</strong><button type="button" className="text-btn" onClick={() => setDrawer(false)}>닫기</button></header>{palette}
    </div>}
  </div>;
}
