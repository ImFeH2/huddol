import { AlertTriangle, Save, SquarePen, Trash2 } from "lucide-react";
import { useCallback, useEffect, useId, useState } from "react";
import { useNavigate } from "../../app/router";
import {
  Page,
  PageBody,
  PageHeader,
  Toolbar,
  ToolbarSpacer,
} from "../../components/layout/shell";
import { ConfirmDialog, PromptDialog } from "../../components/ui/dialog";
import { Banner, Button, Chip, EmptyState } from "../../components/ui/index";
import { BackendError, backend } from "../../lib/backend";
import { documentFolder, formatBytes } from "../../lib/format";
import "./library.css";

type Loaded = { content: string; hash: string };

export function DocumentPage({ path }: { path: string }) {
  const navigate = useNavigate();
  const editorId = useId();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [draft, setDraft] = useState("");
  const [missing, setMissing] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [saved, setSaved] = useState(false);
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

  const dirty = loaded !== null && draft !== loaded.content;

  const save = async () => {
    if (!dirty || loaded === null) return;
    setBusy(true);
    setSaved(false);
    try {
      const result = await backend.writeLibrary(path, draft, loaded.hash);
      if (result.conflict) {
        setConflict(true);
        return;
      }
      setLoaded({ content: draft, hash: result.hash });
      setSaved(true);
    } catch (failure) {
      backend.reportFailure(failure);
    } finally {
      setBusy(false);
    }
  };

  if (missing) {
    return (
      <Page>
        <PageHeader
          title="Document not found"
          crumb={{
            label: "Library",
            onSelect: () => navigate({ name: "library" }),
          }}
        />
        <PageBody>
          <EmptyState
            title="Nothing at this path"
            description="It may have been renamed or deleted by another Member."
            action={
              <Button onClick={() => navigate({ name: "library" })}>
                Back to the Library
              </Button>
            }
          />
        </PageBody>
      </Page>
    );
  }

  const folder = documentFolder(path);

  return (
    <Page>
      <PageHeader
        title={path}
        lede="Every Member can read and edit this document. Saving checks that nobody changed it while you were writing."
        crumb={{
          label: "Library",
          onSelect: () => navigate({ name: "library" }),
        }}
        actions={
          <Button variant="primary" disabled={!dirty || busy} onClick={save}>
            <Save size={16} />
            {busy ? "Saving" : "Save"}
          </Button>
        }
      />
      <Toolbar>
        {folder ? <Chip>{folder}</Chip> : null}
        <Chip>{formatBytes(draft.length)}</Chip>
        {dirty ? <Chip tone="blue">Unsaved changes</Chip> : null}
        <ToolbarSpacer />
        <Button onClick={() => setRenaming(true)}>
          <SquarePen size={15} />
          Rename
        </Button>
        <Button variant="danger" onClick={() => setDoomed(true)}>
          <Trash2 size={15} />
          Delete
        </Button>
      </Toolbar>
      <PageBody variant="flush">
        <div className="editor-shell">
          {conflict ? (
            <Banner
              tone="warning"
              icon={<AlertTriangle size={16} />}
              onDismiss={() => setConflict(false)}
            >
              Another Member saved this document while you were editing. Reopen
              it to see their version; saving now would discard their work.
            </Banner>
          ) : null}
          {saved && !dirty ? (
            <Banner tone="success" onDismiss={() => setSaved(false)}>
              Saved.
            </Banner>
          ) : null}
          <div className="editor">
            <label className="form-label" htmlFor={editorId}>
              Markdown
            </label>
            <textarea
              id={editorId}
              className="editor-area"
              value={draft}
              spellCheck={false}
              onChange={(event) => setDraft(event.target.value)}
            />
            <div className="editor-status">
              <span className="muted">
                {dirty
                  ? "Unsaved. Saving fails if someone else changed the document first."
                  : "Up to date with what every other Member sees."}
              </span>
            </div>
          </div>
        </div>
      </PageBody>

      <PromptDialog
        open={renaming}
        onOpenChange={setRenaming}
        title="Rename document"
        description="Agents are told to record readable names alongside any reference, but a rename can still leave stale pointers in someone's Memory."
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
        description="The document is removed for every Member. This cannot be undone."
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
