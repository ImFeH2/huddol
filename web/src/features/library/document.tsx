import { Check, Save, SquarePen, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { type Route, useNavigate } from "@/app/router";
import {
  type Crumb,
  Page,
  PageBody,
  PageHeader,
  Toolbar,
} from "@/components/layout/shell";
import { ConfirmDialog, PromptDialog } from "@/components/ui/dialog";
import {
  Button,
  Chip,
  dismissToast,
  EmptyState,
  Textarea,
  toast,
} from "@/components/ui/index";
import { OverflowMenu } from "@/components/ui/menu";
import { reportLoadFailure } from "@/features/settings/saver";
import { BackendError, backend } from "@/lib/backend";
import { formatBytes } from "@/lib/format";
import "@/features/library/library.css";

type Loaded = { content: string; hash: string };

type Saved = "shown" | "fading" | null;

const SAVED_HOLD_MS = 2000;

function conflictToastId(path: string): string {
  return `document-conflict:${path}`;
}

export function documentCrumbs(
  path: string,
  navigate: (route: Route) => void,
): Crumb[] {
  const parts = path.split("/");
  return [
    { label: "Library", onSelect: () => navigate({ name: "library" }) },
    ...parts.map((label, index) => ({
      label,
      onSelect: () =>
        navigate({
          name: "library",
          path: parts.slice(0, index + 1).join("/"),
        }),
    })),
  ];
}

export function DocumentUnavailable({
  code,
}: {
  code: "not_found" | "not_readable";
}) {
  return (
    <EmptyState
      title={
        code === "not_readable" ? "Cannot open this file" : "Document not found"
      }
    />
  );
}

export function DocumentPage({ path }: { path: string }) {
  const navigate = useNavigate();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [draft, setDraft] = useState("");
  const [unavailable, setUnavailable] = useState<
    "not_found" | "not_readable" | null
  >(null);
  const [failed, setFailed] = useState(false);
  const [saved, setSaved] = useState<Saved>(null);
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [doomed, setDoomed] = useState(false);

  const load = useCallback(async () => {
    try {
      const document = await backend.readLibrary(path);
      setLoaded({ content: document.content, hash: document.hash });
      setDraft(document.content);
      setUnavailable(null);
      setFailed(false);
      dismissToast(`document-load:${path}`);
      dismissToast(conflictToastId(path));
    } catch (failure) {
      setFailed(true);
      if (
        failure instanceof BackendError &&
        (failure.code === "not_found" || failure.code === "not_readable")
      ) {
        setUnavailable(failure.code);
      } else {
        reportLoadFailure(`document-load:${path}`, failure, () => void load());
      }
    }
  }, [path]);

  useEffect(() => {
    void load();
    return () => dismissToast(`document-load:${path}`);
  }, [load, path]);

  useEffect(() => () => dismissToast(conflictToastId(path)), [path]);

  useEffect(() => {
    if (saved !== "shown") return;
    const timer = setTimeout(() => setSaved("fading"), SAVED_HOLD_MS);
    return () => clearTimeout(timer);
  }, [saved]);

  const dirty = loaded !== null && draft !== loaded.content;
  const crumb = documentCrumbs(path, navigate);

  const save = async () => {
    if (!dirty || loaded === null) return;
    setBusy(true);
    try {
      const result = await backend.writeLibrary(path, draft, loaded.hash);
      if (result.conflict) {
        toast({
          id: conflictToastId(path),
          tone: "danger",
          title: "Saved elsewhere",
          description: path,
          duration: null,
          action: { label: "Reopen", onClick: () => void load() },
        });
        return;
      }
      setLoaded({ content: draft, hash: result.hash });
      setSaved("shown");
      toast({ tone: "success", title: "Saved" });
    } catch (failure) {
      backend.reportFailure(failure);
    } finally {
      setBusy(false);
    }
  };

  if (unavailable) {
    return (
      <Page>
        <PageHeader title={path} crumb={crumb} />
        <PageBody>
          <DocumentUnavailable code={unavailable} />
        </PageBody>
      </Page>
    );
  }

  return (
    <Page>
      <PageHeader
        title={path}
        crumb={crumb}
        actions={
          <>
            <Button
              variant="primary"
              disabled={!dirty || busy || failed}
              onClick={save}
            >
              <Save size={16} />
              {busy ? "Saving" : "Save"}
            </Button>
            <OverflowMenu
              label={`Actions for ${path}`}
              actions={[
                {
                  id: "rename",
                  label: "Rename",
                  icon: <SquarePen size={15} />,
                  onSelect: () => setRenaming(true),
                },
                {
                  id: "delete",
                  label: "Delete",
                  icon: <Trash2 size={15} />,
                  tone: "danger",
                  onSelect: () => setDoomed(true),
                },
              ]}
            />
          </>
        }
      />
      <Toolbar>
        <Chip>{formatBytes(new TextEncoder().encode(draft).length)}</Chip>
        {dirty ? <Chip tone="blue">Unsaved changes</Chip> : null}
        {saved ? (
          <span
            className="saved-chip"
            data-fading={saved === "fading" ? "true" : undefined}
            onTransitionEnd={() =>
              setSaved((current) => (current === "fading" ? null : current))
            }
          >
            <Chip tone="success">
              <Check size={12} />
              Saved
            </Chip>
          </span>
        ) : null}
      </Toolbar>
      <PageBody variant="flush">
        <div className="editor-shell">
          <div className="editor">
            <Textarea
              aria-label="Document"
              disabled={loaded === null || failed}
              value={draft}
              spellCheck={false}
              onChange={(event) => {
                setDraft(event.target.value);
                setSaved(null);
              }}
            />
          </div>
        </div>
      </PageBody>

      <PromptDialog
        open={renaming}
        onOpenChange={setRenaming}
        title="Rename document"
        label="New path"
        initial={path}
        submitLabel="Rename"
        onSubmit={async (destination) => {
          const moved = await backend.moveLibrary(path, destination);
          setRenaming(false);
          navigate({ name: "document", path: moved.path });
        }}
      />
      <ConfirmDialog
        open={doomed}
        onOpenChange={setDoomed}
        title={`Delete ${path}?`}
        description="The document is removed for every Member."
        confirmLabel="Delete document"
        onConfirm={async () => {
          await backend.deleteLibrary(path);
          setDoomed(false);
          navigate({ name: "library" });
        }}
      />
    </Page>
  );
}
