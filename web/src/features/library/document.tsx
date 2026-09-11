import { AlertTriangle, Check, Save, SquarePen, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "@/app/router";
import { Page, PageBody, PageHeader, Toolbar } from "@/components/layout/shell";
import { ConfirmDialog, PromptDialog } from "@/components/ui/dialog";
import {
  Banner,
  Button,
  Chip,
  EmptyState,
  Textarea,
} from "@/components/ui/index";
import { OverflowMenu } from "@/components/ui/menu";
import { BackendError, backend } from "@/lib/backend";
import { documentFolder, formatBytes } from "@/lib/format";
import "@/features/library/library.css";

type Loaded = { content: string; hash: string };

type Saved = "shown" | "fading" | null;

const SAVED_HOLD_MS = 2000;

export function DocumentPage({ path }: { path: string }) {
  const navigate = useNavigate();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [draft, setDraft] = useState("");
  const [missing, setMissing] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [saved, setSaved] = useState<Saved>(null);
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [doomed, setDoomed] = useState(false);

  const load = useCallback(async () => {
    try {
      const document = await backend.readLibrary(path);
      setLoaded({ content: document.content, hash: document.hash });
      setDraft(document.content);
      setMissing(false);
      setConflict(false);
    } catch (failure) {
      if (failure instanceof BackendError && failure.code === "not_found") {
        setMissing(true);
      } else {
        backend.reportFailure(failure);
      }
    }
  }, [path]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (saved !== "shown") return;
    const timer = setTimeout(() => setSaved("fading"), SAVED_HOLD_MS);
    return () => clearTimeout(timer);
  }, [saved]);

  const dirty = loaded !== null && draft !== loaded.content;
  const folder = documentFolder(path);
  const crumb = {
    label: "Library",
    onSelect: () => navigate({ name: "library" }),
  };

  const save = async () => {
    if (!dirty || loaded === null) return;
    setBusy(true);
    try {
      const result = await backend.writeLibrary(path, draft, loaded.hash);
      if (result.conflict) {
        setConflict(true);
        return;
      }
      setLoaded({ content: draft, hash: result.hash });
      setSaved("shown");
    } catch (failure) {
      backend.reportFailure(failure);
    } finally {
      setBusy(false);
    }
  };

  if (missing) {
    return (
      <Page>
        <PageHeader title={path} crumb={crumb} />
        <PageBody>
          <EmptyState title="Document not found" />
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
            <Button variant="primary" disabled={!dirty || busy} onClick={save}>
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
        {folder ? <Chip>{folder}</Chip> : null}
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
          {conflict ? (
            <Banner
              tone="warning"
              icon={<AlertTriangle size={16} />}
              onDismiss={() => setConflict(false)}
            >
              Someone saved this document while you were editing. Reopen it to
              see their version.
            </Banner>
          ) : null}
          <div className="editor">
            <Textarea
              aria-label="Document"
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
