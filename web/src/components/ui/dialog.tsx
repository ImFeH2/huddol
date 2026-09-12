import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { Button, Field, IconButton, Input, toast } from "@/components/ui/index";
import "@/components/ui/dialog.css";

export function dialogFocusTarget<
  T extends { disabled?: boolean },
  U extends { disabled?: boolean },
>(fields: T[], buttons: U[]): T | U | null {
  const field = fields.find((item) => !item.disabled);
  if (field) return field;
  const enabled = buttons.filter((item) => !item.disabled);
  return enabled.length > 0 ? enabled[enabled.length - 1] : null;
}

function reportFailure(title: string, failure: unknown) {
  toast({
    tone: "danger",
    title,
    description: failure instanceof Error ? failure.message : String(failure),
  });
}

function refocus(target: { focus: () => void } | null) {
  requestAnimationFrame(() => {
    if (document.activeElement === document.body) target?.focus();
  });
}

export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  footer: ReactNode;
}) {
  const opener = useRef<HTMLElement | null>(null);
  const content = useRef<HTMLDivElement>(null);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content
          ref={content}
          className="dialog"
          onOpenAutoFocus={(event) => {
            opener.current =
              document.activeElement instanceof HTMLElement
                ? document.activeElement
                : null;
            event.preventDefault();
            const root = content.current;
            if (!root) return;
            const target = dialogFocusTarget(
              Array.from(
                root.querySelectorAll<
                  HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
                >("input, textarea, select"),
              ),
              Array.from(
                root.querySelectorAll<HTMLButtonElement>(
                  ".dialog-footer button",
                ),
              ),
            );
            (target ?? root).focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            opener.current?.focus();
          }}
          {...(description ? {} : { "aria-describedby": undefined })}
        >
          <div className="dialog-head">
            <Dialog.Title className="dialog-title">{title}</Dialog.Title>
            <Dialog.Close asChild>
              <IconButton label="Close" size="sm">
                <X size={15} />
              </IconButton>
            </Dialog.Close>
          </div>
          {description ? (
            <Dialog.Description className="dialog-description">
              {description}
            </Dialog.Description>
          ) : null}
          {children ? <div className="dialog-body">{children}</div> : null}
          <div className="dialog-footer">{footer}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function PromptDialog({
  open,
  onOpenChange,
  title,
  label,
  placeholder,
  initial = "",
  submitLabel,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  label: string;
  placeholder?: string;
  initial?: string;
  submitLabel: string;
  onSubmit: (value: string) => void | Promise<void>;
}) {
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const inputId = useId();

  useEffect(() => {
    if (open) setValue(initial);
  }, [open, initial]);

  const commit = async () => {
    const trimmed = value.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    try {
      await onSubmit(trimmed);
      onOpenChange(false);
    } catch (failure) {
      reportFailure(`Could not ${submitLabel.toLowerCase()}`, failure);
      refocus(input.current);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      footer={
        <>
          <Button disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!value.trim() || busy}
            onClick={commit}
          >
            {submitLabel}
          </Button>
        </>
      }
    >
      <Field label={label} htmlFor={inputId}>
        <Input
          ref={input}
          id={inputId}
          value={value}
          placeholder={placeholder}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void commit();
            }
          }}
        />
      </Field>
    </Modal>
  );
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  onConfirm: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const action = useRef<HTMLButtonElement>(null);

  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onConfirm();
      onOpenChange(false);
    } catch (failure) {
      reportFailure(`Could not ${confirmLabel.toLowerCase()}`, failure);
      refocus(action.current);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      footer={
        <>
          <Button disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            ref={action}
            variant="danger"
            disabled={busy}
            onClick={confirm}
          >
            {confirmLabel}
          </Button>
        </>
      }
    />
  );
}
