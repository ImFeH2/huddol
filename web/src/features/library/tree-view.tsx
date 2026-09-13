import { ChevronDown, ChevronRight, FileText, Folder } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { type Column, RowLink, Table } from "@/components/layout/shell";
import { Chip, CountPill } from "@/components/ui/index";
import { type MenuAction, OverflowMenu } from "@/components/ui/menu";
import { Tooltip } from "@/components/ui/tooltip";
import { buildTree, type TreeNode } from "@/features/library/tree";
import type { LibraryEntry } from "@/lib/backend";
import {
  documentFolder,
  documentName,
  formatBytes,
  formatTime,
  relativeTime,
} from "@/lib/format";

export type TreeViewProps = {
  entries: LibraryEntry[];
  expanded: ReadonlySet<string>;
  onToggle: (path: string) => void;
  onOpen: (path: string) => void;
  rowActions?: (entry: LibraryEntry) => MenuAction[];
  readOnly?: boolean;
  query?: string;
  revealPath?: string;
};

export function TreeView({
  entries,
  expanded,
  onToggle,
  onOpen,
  rowActions,
  readOnly = false,
  query = "",
  revealPath,
}: TreeViewProps) {
  const roots = useMemo(() => buildTree(entries), [entries]);
  const container = useRef<HTMLDivElement>(null);
  const revealed = useRef<string | undefined>(undefined);
  const needle = query.trim().toLowerCase();
  const actions = readOnly ? undefined : rowActions;
  const columns: Column[] = [
    { key: "file", label: "File" },
    ...(needle
      ? [{ key: "folder", label: "Folder", hideBelow: "md" as const }]
      : []),
    { key: "size", label: "Size", align: "end", width: "100px" },
    { key: "modified", label: "Modified", hideBelow: "sm", width: "160px" },
    ...(actions ? [{ key: "actions", label: "", width: "56px" }] : []),
  ];
  const rows: { node: TreeNode; depth: number }[] = [];
  const visit = (nodes: TreeNode[], depth: number) => {
    for (const node of nodes) {
      if (needle) {
        if (node.kind === "file" && node.path.toLowerCase().includes(needle)) {
          rows.push({ node, depth: 0 });
        }
        visit(node.children, 0);
      } else {
        rows.push({ node, depth });
        if (expanded.has(node.path)) visit(node.children, depth + 1);
      }
    }
  };
  visit(roots, 0);

  useEffect(() => {
    if (!revealPath || revealed.current === revealPath || needle) return;
    const row = Array.from(
      container.current?.querySelectorAll<HTMLElement>("[data-path]") ?? [],
    ).find((item) => item.dataset.path === revealPath);
    if (row) {
      row.scrollIntoView({ block: "nearest" });
      revealed.current = revealPath;
    }
  }, [revealPath, needle, entries, expanded]);

  return (
    <div ref={container} className="min-w-0">
      <Table
        columns={columns}
        label={readOnly ? "Memory files" : "Library documents"}
      >
        {rows.map(({ node, depth }) => {
          const folder = node.kind === "directory";
          const open = expanded.has(node.path);
          return (
            <tr key={node.path} data-path={node.path}>
              <td>
                <div
                  className="flex min-w-0 items-center gap-2"
                  style={{ paddingLeft: depth * 16 }}
                >
                  <span
                    className="flex w-8 flex-none items-center justify-end gap-1 text-fg-muted"
                    aria-hidden="true"
                  >
                    {folder ? (
                      <>
                        {open ? (
                          <ChevronDown size={14} />
                        ) : (
                          <ChevronRight size={14} />
                        )}
                        <Folder size={15} />
                      </>
                    ) : (
                      <FileText size={15} />
                    )}
                  </span>
                  {folder || node.hash !== null ? (
                    <RowLink
                      primary={
                        <span className="min-w-0 whitespace-normal wrap-anywhere">
                          {documentName(node.path)}
                        </span>
                      }
                      expanded={folder ? open : undefined}
                      onSelect={() =>
                        folder ? onToggle(node.path) : onOpen(node.path)
                      }
                    />
                  ) : (
                    <span className="min-w-0 whitespace-normal wrap-anywhere">
                      {documentName(node.path)}
                    </span>
                  )}
                  {folder ? (
                    <CountPill>
                      {node.fileCount.toLocaleString("en-US")}
                    </CountPill>
                  ) : null}
                  {!folder && node.hash === null ? (
                    <Chip>Unreadable</Chip>
                  ) : null}
                </div>
              </td>
              {needle ? (
                <td data-hide-below="md">
                  <Chip>{documentFolder(node.path) ?? "Root"}</Chip>
                </td>
              ) : null}
              <td
                data-align="end"
                className="tabular-nums whitespace-nowrap text-fg-muted"
              >
                {folder ? null : formatBytes(node.size)}
              </td>
              <td data-hide-below="sm" className="text-fg-muted">
                <Tooltip label={formatTime(node.modified_at)} focusable>
                  <time
                    className="relative whitespace-nowrap"
                    dateTime={node.modified_at}
                  >
                    {relativeTime(node.modified_at)}
                  </time>
                </Tooltip>
              </td>
              {actions ? (
                <td className="relative z-1 w-12 text-right">
                  <OverflowMenu
                    label={`Actions for ${node.path}`}
                    actions={actions(node)}
                  />
                </td>
              ) : null}
            </tr>
          );
        })}
      </Table>
    </div>
  );
}
