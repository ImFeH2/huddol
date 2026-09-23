const scrollKeys = new Set([
  "ArrowDown",
  "ArrowUp",
  "PageDown",
  "PageUp",
  "Home",
  "End",
  " ",
]);

const interactiveSelector =
  "input, textarea, select, [contenteditable]:not([contenteditable='false']), button, a[href], [role='button'], [role='textbox'], [role='menuitem'], [role='menuitemcheckbox'], [role='menuitemradio'], [role='checkbox'], [role='radio'], [role='switch'], [role='slider'], [role='combobox'], [role='option'], [tabindex]:not([tabindex='-1'])";

export function centeredScrollTop(
  scrollTop: number,
  maxScrollTop: number,
  markerTop: number,
  readableTop: number,
  readableBottom: number,
): number {
  const target = (readableTop + readableBottom) / 2;
  return Math.max(0, Math.min(maxScrollTop, scrollTop + markerTop - target));
}

export function shouldStopPositioningForKey(
  key: string,
  target: Pick<Element, "closest">,
): boolean {
  return scrollKeys.has(key) && !target.closest(interactiveSelector);
}
