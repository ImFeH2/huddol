import { type RefObject, useState } from "react";
import { toast } from "@/components/ui/index";
import { backend } from "@/lib/backend";

export function useSaver(
  load: () => Promise<void>,
  field: RefObject<HTMLElement | null>,
) {
  const [saving, setSaving] = useState(false);

  const save = async (section: string, values: Record<string, unknown>) => {
    setSaving(true);
    try {
      await backend.updateSettings(section, values);
      toast({ tone: "success", title: "Saved" });
      await load();
      return true;
    } catch (error) {
      toast({
        tone: "danger",
        title: "Could not save",
        description: error instanceof Error ? error.message : String(error),
      });
      return false;
    } finally {
      setSaving(false);
      requestAnimationFrame(() => {
        if (document.activeElement === document.body) field.current?.focus();
      });
    }
  };

  return { saving, save };
}

export function reportLoadFailure(
  id: string,
  failure: unknown,
  retry: () => void,
): void {
  toast({
    id,
    tone: "danger",
    title: "Could not load",
    description: failure instanceof Error ? failure.message : String(failure),
    duration: null,
    action: { label: "Retry", onClick: retry },
  });
}
