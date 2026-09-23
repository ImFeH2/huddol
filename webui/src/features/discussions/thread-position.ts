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
