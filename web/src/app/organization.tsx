import { createContext, type ReactNode, useContext } from "react";
import type { Member } from "../lib/backend";

export type Organization = {
  members: Member[];
  humanId: number;
  refresh: () => Promise<void>;
};

const OrganizationContext = createContext<Organization | null>(null);

export function OrganizationProvider({
  value,
  children,
}: {
  value: Organization;
  children: ReactNode;
}) {
  return (
    <OrganizationContext.Provider value={value}>
      {children}
    </OrganizationContext.Provider>
  );
}

export function useOrganization(): Organization {
  const value = useContext(OrganizationContext);
  if (!value) throw new Error("useOrganization used outside its provider");
  return value;
}

export function useMe(): Member | undefined {
  const { members, humanId } = useOrganization();
  return members.find((member) => member.id === humanId);
}
