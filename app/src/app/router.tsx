import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";

export type Route =
  | { name: "discussions" }
  | { name: "discussion"; id: number }
  | { name: "members" }
  | { name: "member"; id: number }
  | { name: "library" }
  | { name: "document"; path: string }
  | { name: "model" }
  | { name: "execution" }
  | { name: "limits" }
  | { name: "langfuse" };

export type NavId =
  | "discussions"
  | "members"
  | "library"
  | "model"
  | "limits"
  | "langfuse"
  | "execution";

const NAV_OF: Record<Route["name"], NavId> = {
  discussions: "discussions",
  discussion: "discussions",
  members: "members",
  member: "members",
  library: "library",
  document: "library",
  model: "model",
  execution: "execution",
  limits: "limits",
  langfuse: "langfuse",
};

export function navIdOf(route: Route): NavId {
  return NAV_OF[route.name];
}

type Router = { route: Route; navigate: (next: Route) => void; back: boolean };

const RouterContext = createContext<Router | null>(null);

export function RouterProvider({ children }: { children: ReactNode }) {
  const [stack, setStack] = useState<Route[]>([{ name: "discussions" }]);

  const navigate = useCallback((next: Route) => {
    setStack((current) => {
      const top = current[current.length - 1];
      if (top.name === next.name && sameParams(top, next)) return current;
      return [...current, next].slice(-24);
    });
  }, []);

  const value = useMemo<Router>(
    () => ({
      route: stack[stack.length - 1],
      navigate,
      back: stack.length > 1,
    }),
    [stack, navigate],
  );

  return (
    <RouterContext.Provider value={value}>{children}</RouterContext.Provider>
  );
}

function sameParams(a: Route, b: Route): boolean {
  const left = "id" in a ? a.id : "path" in a ? a.path : null;
  const right = "id" in b ? b.id : "path" in b ? b.path : null;
  return left === right;
}

export function useRouter(): Router {
  const value = useContext(RouterContext);
  if (!value) throw new Error("useRouter used outside RouterProvider");
  return value;
}

export function useNavigate(): (next: Route) => void {
  return useRouter().navigate;
}
