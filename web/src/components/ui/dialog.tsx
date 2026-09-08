import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { Button, Field, IconButton, Input } from "./index";
import "./dialog.css";

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
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content
          className="dialog"
          onOpenAutoFocus={() => {
            opener.current =
              document.activeElement instanceof HTMLElement
                ? document.activeElement
                : null;
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
  description,
  label,
  hint,
  placeholder,
  initial = "",
  submitLabel,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  label: string;
  hint?: ReactNode;
  placeholder?: string;
  initial?: string;
  submitLabel: string;
  onSubmit: (value: string) => void | Promise<void>;
}) {
  const [value, setValue] = useState(initial);
  const inputId = useId();

  useEffect(() => {
    if (open) setValue(initial);
  }, [open, initial]);

  const commit = async () => {
    const trimmed = value.trim();
    if (!trimmed) return;
    await onSubmit(trimmed);
    onOpenChange(false);
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" disabled={!value.trim()} onClick={commit}>
            {submitLabel}
          </Button>
        </>
      }
    >
      <Field label={label} htmlFor={inputId} hint={hint}>
        <Input
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
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant="danger"
            onClick={async () => {
              await onConfirm();
              onOpenChange(false);
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    />
  );
}
