export type Placement = "bottom-start" | "bottom-end" | "top-start" | "top-end";

export interface PositionOptions {
  offset?: number;
  padding?: number;
  placement?: Placement;
}

/** Place a popover with flip and viewport clamping using browser primitives. */
export function placeAnchor(
  anchor: HTMLElement,
  floating: HTMLElement,
  { placement = "bottom-start", offset = 8, padding = 8 }: PositionOptions = {},
): void {
  const anchorRect = anchor.getBoundingClientRect();
  const floatingRect = floating.getBoundingClientRect();
  const viewportWidth = window.visualViewport?.width ?? window.innerWidth;
  const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
  const viewportLeft = window.visualViewport?.offsetLeft ?? 0;
  const viewportTop = window.visualViewport?.offsetTop ?? 0;
  const preferTop = placement.startsWith("top");
  const canFitBelow =
    viewportTop + viewportHeight - anchorRect.bottom >= floatingRect.height + offset;
  const canFitAbove = anchorRect.top - viewportTop >= floatingRect.height + offset;
  const top = preferTop ? canFitAbove || !canFitBelow : !canFitBelow && canFitAbove;
  const y = top ? anchorRect.top - floatingRect.height - offset : anchorRect.bottom + offset;
  const preferredX = placement.endsWith("end")
    ? anchorRect.right - floatingRect.width
    : anchorRect.left;
  const x = Math.max(
    viewportLeft + padding,
    Math.min(preferredX, viewportLeft + viewportWidth - floatingRect.width - padding),
  );
  const clampedY = Math.max(
    viewportTop + padding,
    Math.min(y, viewportTop + viewportHeight - floatingRect.height - padding),
  );

  Object.assign(floating.style, {
    position: "fixed",
    top: `${Math.round(clampedY)}px`,
    left: `${Math.round(x)}px`,
    margin: "0",
  });
}
