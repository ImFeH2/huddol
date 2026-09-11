import { type RefObject, useState } from "react";
import { backend } from "@/lib/backend";

export function useSaver(
  load: () => Promise<void>,
  field: RefObject<HTMLElement | null>,
) {
  const [status, setStatus] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState(false);

  const save = async (section: string, values: Record<string, unknown>) => {
    setStatus(null);
    setSaving(true);
    try {
      await backend.updateSettings(section, values);
      setFailed(false);
      setStatus("Saved.");
      await load();
      return true;
    } catch (error) {
      setFailed(true);
      setStatus(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setSaving(false);
      requestAnimationFrame(() => {
        if (document.activeElement === document.body) field.current?.focus();
      });
    }
  };

  return { status, failed, saving, save, dismiss: () => setStatus(null) };
}
