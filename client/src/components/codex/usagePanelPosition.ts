export interface UsagePanelAnchorRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
}
export interface UsagePanelViewport {
  width: number;
  height: number;
  offsetLeft: number;
  offsetTop: number;
  layoutHeight: number;
}

export interface UsagePanelPlacement {
  left: number;
  width: number;
  maxHeight: number;
  top: number | null;
  bottom: number | null;
  opensAbove: boolean;
}

const VIEWPORT_MARGIN = 12;
const ANCHOR_GAP = 8;
const MAX_PANEL_WIDTH = 368;
const MAX_PANEL_HEIGHT = 608;
const PREFERRED_PANEL_HEIGHT = 320;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}

export function resolveUsagePanelPlacement(
  anchor: UsagePanelAnchorRect,
  viewport: UsagePanelViewport
): UsagePanelPlacement {
  const width = Math.max(0, Math.min(MAX_PANEL_WIDTH, viewport.width - (VIEWPORT_MARGIN * 2)));
  const viewportLeft = viewport.offsetLeft + VIEWPORT_MARGIN;
  const viewportRight = viewport.offsetLeft + viewport.width - VIEWPORT_MARGIN;
  const centeredLeft = anchor.left + (anchor.width / 2) - (width / 2);
  const left = clamp(centeredLeft, viewportLeft, viewportRight - width);

  const viewportTop = viewport.offsetTop + VIEWPORT_MARGIN;
  const viewportBottom = viewport.offsetTop + viewport.height - VIEWPORT_MARGIN;
  const spaceAbove = Math.max(0, anchor.top - ANCHOR_GAP - viewportTop);
  const spaceBelow = Math.max(0, viewportBottom - anchor.bottom - ANCHOR_GAP);
  const opensAbove = spaceAbove >= Math.min(PREFERRED_PANEL_HEIGHT, MAX_PANEL_HEIGHT)
    || spaceAbove >= spaceBelow;
  const availableHeight = opensAbove ? spaceAbove : spaceBelow;
  const maxHeight = Math.max(0, Math.min(MAX_PANEL_HEIGHT, availableHeight));

  return {
    left,
    width,
    maxHeight,
    top: opensAbove ? null : anchor.bottom + ANCHOR_GAP,
    bottom: opensAbove ? Math.max(0, viewport.layoutHeight - anchor.top + ANCHOR_GAP) : null,
    opensAbove,
  };
}
