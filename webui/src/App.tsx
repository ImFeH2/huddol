import { BookText, MessagesSquare, Plus, Settings, Users } from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { OrganizationProvider } from "@/app/organization";
import {
  navIdOf,
  pageKeyOf,
  type Route,
  RouterProvider,
  useNavigate,
  useRouter,
} from "@/app/router";
import {
  Nav,
  NavItem,
  NavSubItem,
  PageTransition,
  Shell,
  Sidebar,
  SidebarBrand,
} from "@/components/layout/shell";
import { AccessError } from "@/components/ui/access-error";
import {
  Badge,
  dismissToast,
  IconButton,
  Spinner,
  StateDot,
  Toaster,
  toast,
} from "@/components/ui/index";
import { TooltipProvider } from "@/components/ui/tooltip";
import { CreateDiscussionDialog } from "@/features/discussions/create";
import { DiscussionsPage } from "@/features/discussions/list";
import { ThreadPage } from "@/features/discussions/thread";
import { DocumentPage } from "@/features/library/document";
import { LibraryPage } from "@/features/library/list";
import { MemberPage } from "@/features/members/detail";
import { MembersPage } from "@/features/members/list";
import { SettingsPage } from "@/features/settings/page";
import {
  BackendError,
  backend,
  type DiscussionSummary,
  type Member,
} from "@/lib/backend";
import "@/styles/App.css";

type Loaded = {
  members: Member[];
  humanId: number;
  tokenLimit: number;
  discussions: DiscussionSummary[];
};

function View({ route, tokenLimit }: { route: Route; tokenLimit: number }) {
  switch (route.name) {
    case "discussions":
      return <DiscussionsPage />;
    case "discussion":
      return <ThreadPage id={route.id} />;
    case "members":
      return <MembersPage tokenLimit={tokenLimit} />;
    case "member":
      return <MemberPage id={route.id} />;
    case "library":
      return <LibraryPage path={route.path} />;
    case "document":
      return <DocumentPage path={route.path} />;
    case "settings":
      return <SettingsPage section={route.section} />;
  }
}

const CONNECTION_TOAST = "connection";

function reconnect() {
  void backend.reconnect().catch(backend.reportFailure);
}

function reportBackendFailure(error: BackendError) {
  const uncertain = error.code === "unconfirmed";
  const disconnected = backend.disconnected && !uncertain;
  toast({
    id: uncertain ? undefined : error.transport ? CONNECTION_TOAST : undefined,
    tone: "danger",
    title: uncertain
      ? "Check operation result"
      : error.transport
        ? "Connection lost"
        : "Request failed",
    description: error.message,
    duration: disconnected || uncertain ? null : undefined,
    closable: !disconnected,
    action: disconnected
      ? { label: "Reconnect", onClick: reconnect }
      : undefined,
  });
}

function Chrome({ loaded }: { loaded: Loaded }) {
  const { route } = useRouter();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const active = navIdOf(route);
  const unlisted =
    route.name === "discussion" &&
    !loaded.discussions.some((item) => item.id === route.id);
  const running = new Set(
    loaded.members
      .filter((member) => member.type === "agent" && member.state === "running")
      .map((member) => member.id),
  );
  const unread = loaded.discussions.reduce(
    (total, item) => total + item.unread,
    0,
  );

  return (
    <Shell
      sidebar={
        <Sidebar
          footer={
            <Nav label="Settings">
              <NavItem
                icon={<Settings size={16} />}
                label="Settings"
                active={active === "settings"}
                onSelect={() => {
                  if (route.name !== "settings")
                    navigate({ name: "settings", section: "model" });
                }}
              />
            </Nav>
          }
        >
          <SidebarBrand />
          <Nav label="Sections">
            <NavItem
              icon={<MessagesSquare size={16} />}
              label="Discussions"
              active={route.name === "discussions" || unlisted}
              badge={
                unread > 0 ? (
                  <Badge key={unread} tone="unread">
                    {unread}
                  </Badge>
                ) : undefined
              }
              trailing={
                <IconButton
                  size="sm"
                  label="New Discussion"
                  onClick={() => setCreating(true)}
                >
                  <Plus size={15} />
                </IconButton>
              }
              onSelect={() => navigate({ name: "discussions" })}
            >
              {loaded.discussions.map((item) => (
                <NavSubItem
                  key={item.id}
                  label={item.topic}
                  active={route.name === "discussion" && route.id === item.id}
                  badge={
                    item.unread > 0 ? (
                      <Badge key={item.unread} tone="unread">
                        {item.unread}
                      </Badge>
                    ) : undefined
                  }
                  indicator={
                    item.member_ids.some((id) => running.has(id)) ? (
                      <StateDot state="running" />
                    ) : undefined
                  }
                  onSelect={() => navigate({ name: "discussion", id: item.id })}
                />
              ))}
            </NavItem>
            <NavItem
              icon={<Users size={16} />}
              label="Members"
              active={active === "members"}
              onSelect={() => navigate({ name: "members" })}
            />
            <NavItem
              icon={<BookText size={16} />}
              label="Library"
              active={active === "library"}
              onSelect={() => navigate({ name: "library" })}
            />
          </Nav>
        </Sidebar>
      }
    >
      <PageTransition id={pageKeyOf(route)}>
        <View route={route} tokenLimit={loaded.tokenLimit} />
      </PageTransition>
      <CreateDiscussionDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={(id) => navigate({ name: "discussion", id })}
      />
    </Shell>
  );
}

export default function App() {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [failure, setFailure] = useState<BackendError | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const booted = useRef(false);

  const refresh = useCallback(async () => {
    const [organization, discussions] = await Promise.all([
      backend.organization(),
      backend.discussions(),
    ]);
    setLoaded({
      members: organization.members,
      humanId: organization.human_id,
      tokenLimit: organization.token_limit ?? 0,
      discussions,
    });
    booted.current = true;
  }, []);

  useEffect(
    () =>
      backend.onFailure((error) => {
        setReconnecting(false);
        if (booted.current) reportBackendFailure(error);
        else setFailure(error);
      }),
    [],
  );

  useEffect(() => {
    backend
      .connect()
      .then(refresh)
      .catch((error) =>
        setFailure(
          error instanceof BackendError
            ? error
            : new BackendError(
                "startup_failed",
                "Huddol could not finish starting. Close this window and start Huddol again.",
              ),
        ),
      );
  }, [refresh]);

  useEffect(() => {
    return backend.onEvent((event) => {
      if (event.type === "connection.reconnecting") {
        setReconnecting(true);
        if (booted.current)
          toast({
            id: CONNECTION_TOAST,
            tone: "info",
            title: "Reconnecting…",
            duration: null,
            closable: false,
          });
      }
      if (event.type === "connection.restored") {
        dismissToast(CONNECTION_TOAST);
        setReconnecting(false);
        setFailure(null);
      }
      if (
        event.type === "connection.restored" ||
        event.type.startsWith("member.") ||
        event.type.startsWith("turn.") ||
        event.type === "message.created" ||
        event.type === "discussion.read_updated" ||
        event.type === "mention.acked" ||
        event.type === "mention.revoked" ||
        event.type === "discussion.created" ||
        event.type === "discussion.updated"
      ) {
        void refresh().catch(backend.reportFailure);
      }
    });
  }, [refresh]);

  useEffect(() => {
    const online = () => {
      void backend.reconnect(true).catch(backend.reportFailure);
    };
    const visible = () => {
      if (document.visibilityState === "visible") online();
    };
    window.addEventListener("online", online);
    document.addEventListener("visibilitychange", visible);
    return () => {
      window.removeEventListener("online", online);
      document.removeEventListener("visibilitychange", visible);
    };
  }, []);

  let body: ReactNode;
  if (failure && !loaded) {
    body = (
      <AccessError
        error={failure}
        reconnect={reconnect}
        waiting={reconnecting}
      />
    );
  } else if (!loaded) {
    body = (
      <div className="flex flex-col items-center justify-center gap-3 h-screen bg-surface">
        <Spinner label="Starting Huddol" />
        <p className="text-fg-muted">Starting Huddol…</p>
      </div>
    );
  } else {
    body = (
      <RouterProvider>
        <OrganizationProvider
          value={{
            members: loaded.members,
            humanId: loaded.humanId,
            discussions: loaded.discussions,
            refresh,
          }}
        >
          <Chrome loaded={loaded} />
        </OrganizationProvider>
      </RouterProvider>
    );
  }

  return (
    <TooltipProvider>
      {body}
      <Toaster />
    </TooltipProvider>
  );
}
