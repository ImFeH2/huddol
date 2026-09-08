import {
  FileText,
  Plus,
  RefreshCw,
  Search,
  SquarePen,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "../../app/router";
import {
  type Column,
  Page,
  PageBody,
  PageHeader,
  RowLink,
  Table,
  Toolbar,
  ToolbarSpacer,
} from "../../components/layout/shell";
import { ConfirmDialog, PromptDialog } from "../../components/ui/dialog";
import {
  Button,
  Chip,
  CountPill,
  EmptyState,
  IconButton,
  SearchField,
} from "../../components/ui/index";
import { OverflowMenu } from "../../components/ui/menu";
import { backend, type LibraryEntry } from "../../lib/backend";
import {
  documentFolder,
  documentName,
  formatBytes,
  plural,
} from "../../lib/format";
import "./library.css";

const COLUMNS: Column[] = [
  { key: "document", label: "Document" },
  { key: "folder", label: "Folder", width: "220px", hideBelow: "md" },
  { key: "size", label: "Size", align: "end", width: "120px" },
  { key: "actions", label: "", width: "56px" },
];

export function LibraryPage() {
  const navigate = useNavigate();
  const [entries, setEntries] = useState<LibraryEntry[]>([]);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<LibraryEntry | null>(null);
  const [doomed, setDoomed] = useState<LibraryEntry | null>(null);

  const load = useCallback(async () => {
    try {
      setEntries(await backend.library());
    } catch (failure) {
      backend.reportFailure(failure);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return entries;
    return entries.filter((entry) => entry.path.toLowerCase().includes(needle));
  }, [entries, query]);

  return (
    <Page>
      <PageHeader
        title="Library"
        lede="Shared Markdown documents that every Member can read and write. Memory is what one Agent knows privately; the Library is what the organization knows together."
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Plus size={16} />
            New document
          </Button>
        }
      />
      <Toolbar>
        <SearchField
          icon={<Search size={15} />}
          value={query}
          placeholder="Search documents by path"
          aria-label="Search documents"
          onChange={(event) => setQuery(event.target.value)}
        />
        <ToolbarSpacer />
        <IconButton label="Refresh" onClick={() => void load()}>
          <RefreshCw size={15} />
        </IconButton>
      </Toolbar>
      <PageBody>
        <CountPill>{plural(shown.length, "document")}</CountPill>
        {shown.length === 0 ? (
          <EmptyState
            title={
              entries.length === 0
                ? "The Library is empty"
                : "No documents match"
            }
            description={
              entries.length === 0
                ? "Create a document here and every Member can read and edit it."
                : "Clear the search to see everything."
            }
            action={
              entries.length === 0 ? (
                <Button variant="primary" onClick={() => setCreating(true)}>
                  <Plus size={16} />
                  New document
                </Button>
              ) : undefined
            }
          />
        ) : (
          <Table columns={COLUMNS} label="Library documents">
            {shown.map((entry) => (
              <tr className="table-row" key={entry.path}>
                <td>
                  <div className="cell-lead">
                    <span className="doc-glyph" aria-hidden="true">
                      <FileText size={15} />
                    </span>
                    <RowLink
                      primary={documentName(entry.path)}
                      secondary={entry.path}
                      onSelect={() =>
                        navigate({ name: "document", path: entry.path })
                      }
                    />
                  </div>
                </td>
                <td data-hide-below="md">
                  {documentFolder(entry.path) ? (
                    <Chip>{documentFolder(entry.path)}</Chip>
                  ) : (
                    <span className="muted">Root</span>
                  )}
                </td>
                <td data-align="end" className="numeric muted">
                  {formatBytes(entry.size)}
                </td>
                <td className="cell-actions">
                  <OverflowMenu
                    label={`Actions for ${entry.path}`}
                    actions={[
                      {
                        id: "rename",
                        label: "Rename",
                        icon: <SquarePen size={15} />,
                        onSelect: () => setRenaming(entry),
                      },
                      {
                        id: "delete",
                        label: "Delete",
                        icon: <Trash2 size={15} />,
                        tone: "danger",
                        onSelect: () => setDoomed(entry),
                      },
                    ]}
                  />
                </td>
              </tr>
            ))}
          </Table>
        )}
      </PageBody>

      <PromptDialog
        open={creating}
        onOpenChange={setCreating}
        title="New document"
        description="Documents are Markdown files addressed by path. Use folders to keep related ones together."
        label="Path"
        placeholder="runbooks/on-call.md"
        hint="Relative to the Library root."
        submitLabel="Create document"
        onSubmit={async (path) => {
          await backend.writeLibrary(path, "");
          await load();
          navigate({ name: "document", path });
        }}
      />
      <PromptDialog
        open={renaming !== null}
        onOpenChange={(next) => !next && setRenaming(null)}
        title="Rename document"
        description="Agents are told to record readable names alongside any reference, but a rename can still leave stale pointers in someone's Memory."
        label="New path"
        initial={renaming?.path ?? ""}
        submitLabel="Rename"
        onSubmit={async (destination) => {
          if (renaming) await backend.moveLibrary(renaming.path, destination);
          setRenaming(null);
          await load();
        }}
      />
      <ConfirmDialog
        open={doomed !== null}
        onOpenChange={(next) => !next && setDoomed(null)}
        title={`Delete ${doomed?.path ?? ""}?`}
        description="The document is removed for every Member. This cannot be undone."
        confirmLabel="Delete document"
        onConfirm={async () => {
          if (doomed) await backend.deleteLibrary(doomed.path);
          setDoomed(null);
          await load();
        }}
      />
    </Page>
  );
}
