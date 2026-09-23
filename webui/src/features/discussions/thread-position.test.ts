import { Virtualizer } from "@tanstack/react-virtual";
import { describe, expect, it } from "vitest";
import {
  centeredScrollTop,
  shouldStopPositioningForKey,
} from "@/features/discussions/thread-position";

function actualVirtualizer() {
  let time = 0;
  let nextFrame = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const targetWindow = {
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      nextFrame += 1;
      frames.set(nextFrame, callback);
      return nextFrame;
    },
    cancelAnimationFrame: (id: number) => frames.delete(id),
    performance: { now: () => time },
  } as unknown as Window & typeof globalThis;
  const scrollElement = {
    scrollTop: 0,
    scrollHeight: 1000,
    clientHeight: 100,
    ownerDocument: { defaultView: targetWindow },
  } as unknown as HTMLElement;
  const writes: number[] = [];
  let observeOffset:
    | ((offset: number, isScrolling: boolean) => void)
    | undefined;
  const virtual = new Virtualizer<HTMLElement, HTMLElement>({
    count: 3,
    getScrollElement: () => scrollElement,
    estimateSize: () => 100,
    initialRect: { width: 100, height: 100 },
    observeElementRect: (_instance, callback) => {
      callback({ width: 100, height: 100 });
    },
    observeElementOffset: (instance, callback) => {
      observeOffset = callback;
      callback(instance.scrollElement?.scrollTop ?? 0, false);
    },
    scrollToFn: (offset, { adjustments }) => {
      const target = offset + (adjustments ?? 0);
      scrollElement.scrollTop = target;
      observeOffset?.(target, false);
      writes.push(target);
    },
  });
  virtual._willUpdate();
  virtual.getVirtualItems();

  return {
    virtual,
    scrollElement,
    writes,
    flushFrames: () => {
      let count = 0;
      while (frames.size && count < 10) {
        count += 1;
        const entry = frames.entries().next().value;
        if (!entry) return;
        frames.delete(entry[0]);
        time += 16;
        entry[1](time);
      }
      expect(frames.size).toBe(0);
    },
  };
}

describe("New marker positioning", () => {
  it("centers the marker in the readable area after composer occlusion", () => {
    expect(centeredScrollTop(200, 1000, 500, 100, 784)).toBe(258);
  });

  it("clamps the target to the scrollable edges", () => {
    expect(centeredScrollTop(0, 1000, 10, 100, 784)).toBe(0);
    expect(centeredScrollTop(950, 1000, 900, 100, 784)).toBe(1000);
  });
});

describe("virtualizer positioning ownership", () => {
  it("keeps the absolute New target through pending and later row measurements", () => {
    const { virtual, scrollElement, writes, flushFrames } = actualVirtualizer();
    virtual.scrollToIndex(2, { align: "center" });
    virtual.scrollToOffset(100);
    virtual.resizeItem(2, 300);
    virtual.getVirtualItems();
    virtual.resizeItem(2, 500);
    virtual.getVirtualItems();
    flushFrames();

    expect(scrollElement.scrollTop).toBe(100);
    expect(writes).not.toContain(250);

    virtual.resizeItem(2, 900);
    virtual.getVirtualItems();
    flushFrames();
    expect(scrollElement.scrollTop).toBe(100);
  });

  it("keeps the user offset after positioning is interrupted before resize", () => {
    const { virtual, scrollElement, flushFrames } = actualVirtualizer();
    virtual.scrollToIndex(2, { align: "center" });
    scrollElement.scrollTop = 80;
    virtual.scrollToOffset(scrollElement.scrollTop);
    virtual.resizeItem(2, 600);
    virtual.getVirtualItems();
    flushFrames();

    expect(scrollElement.scrollTop).toBe(80);
  });
});

describe("keyboard positioning cancellation", () => {
  const scrollTarget = { closest: () => null } as unknown as Element;

  it.each(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "])(
    "stops entry positioning for %s on the message area",
    (key) => {
      expect(shouldStopPositioningForKey(key, scrollTarget)).toBe(true);
    },
  );

  it.each(["Enter", "Escape", "a"])(
    "keeps entry positioning for non-scroll key %s",
    (key) => {
      expect(shouldStopPositioningForKey(key, scrollTarget)).toBe(false);
    },
  );

  it("preserves scrolling and control keys from interactive elements", () => {
    const input = { closest: () => ({}) } as unknown as Element;
    expect(shouldStopPositioningForKey("ArrowDown", input)).toBe(false);
    expect(shouldStopPositioningForKey(" ", input)).toBe(false);
  });
});
