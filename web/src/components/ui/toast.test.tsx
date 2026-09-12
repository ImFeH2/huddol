import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearToasts,
  dismissToast,
  readToasts,
  subscribeToasts,
  toast,
} from "@/components/ui/toast";

afterEach(() => {
  clearToasts();
  vi.useRealTimers();
});

describe("toast store", () => {
  it("enqueues in order with tone defaults", () => {
    const first = toast({ tone: "success", title: "Saved" });
    const second = toast({ tone: "danger", title: "Could not send" });
    expect(readToasts().map((item) => item.id)).toEqual([first, second]);
    expect(readToasts()[0]).toMatchObject({
      title: "Saved",
      duration: 4000,
      closable: true,
      open: true,
    });
    expect(readToasts()[1].duration).toBeGreaterThan(
      readToasts()[0].duration ?? 0,
    );
  });

  it("updates a toast in place when the id already exists", () => {
    toast({ id: "connection", tone: "danger", title: "Connection lost" });
    toast({ id: "connection", tone: "danger", title: "Connection timed out" });
    expect(readToasts()).toHaveLength(1);
    expect(readToasts()[0].title).toBe("Connection timed out");
    expect(readToasts()[0].revision).toBe(1);
  });

  it("keeps sticky toasts without a duration and honours closable", () => {
    toast({
      id: "connection",
      tone: "danger",
      title: "Connection lost",
      duration: null,
      closable: false,
    });
    expect(readToasts()[0]).toMatchObject({ duration: null, closable: false });
  });

  it("dismisses after the exit animation and notifies subscribers", () => {
    vi.useFakeTimers();
    const seen: number[] = [];
    const stop = subscribeToasts(() => seen.push(readToasts().length));
    const id = toast({ tone: "info", title: "Copied" });
    dismissToast(id);
    expect(readToasts()[0].open).toBe(false);
    vi.runAllTimers();
    expect(readToasts()).toHaveLength(0);
    expect(seen).toEqual([1, 1, 0]);
    stop();
  });

  it("revives a toast that is dismissed and then reissued under the same id", () => {
    vi.useFakeTimers();
    toast({ id: "load", tone: "danger", title: "Could not load" });
    dismissToast("load");
    toast({ id: "load", tone: "danger", title: "Could not load" });
    vi.runAllTimers();
    expect(readToasts()).toHaveLength(1);
    expect(readToasts()[0].open).toBe(true);
  });
});
