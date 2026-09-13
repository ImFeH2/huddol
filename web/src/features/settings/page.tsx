import { type SettingsSection, useNavigate } from "@/app/router";
import { Page, PageBody, PageHeader } from "@/components/layout/shell";
import { type TabItem, Tabs } from "@/components/ui/tabs";
import { AgentPanel } from "@/features/settings/agent";
import { ExecutionPanel } from "@/features/settings/execution";
import { LangfusePanel } from "@/features/settings/langfuse";
import { ModelPanel } from "@/features/settings/model";

const SECTIONS: TabItem<SettingsSection>[] = [
  { id: "model", label: "Model" },
  { id: "execution", label: "Execution" },
  { id: "agent", label: "Agent" },
  { id: "langfuse", label: "Langfuse" },
];

function Panel({ section }: { section: SettingsSection }) {
  switch (section) {
    case "model":
      return <ModelPanel />;
    case "execution":
      return <ExecutionPanel />;
    case "agent":
      return <AgentPanel />;
    case "langfuse":
      return <LangfusePanel />;
  }
}

export function SettingsPage({ section }: { section: SettingsSection }) {
  const navigate = useNavigate();
  return (
    <Page>
      <PageHeader title="Settings" />
      <PageBody>
        <Tabs
          label="Settings"
          tabs={SECTIONS}
          value={section}
          onChange={(next) => navigate({ name: "settings", section: next })}
        >
          <Panel section={section} />
        </Tabs>
      </PageBody>
    </Page>
  );
}
