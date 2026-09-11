import { type SettingsSection, useNavigate } from "@/app/router";
import { Page, PageBody, PageHeader } from "@/components/layout/shell";
import { type TabItem, Tabs } from "@/components/ui/tabs";
import { ExecutionPanel } from "@/features/settings/execution";
import { LangfusePanel } from "@/features/settings/langfuse";
import { LimitsPanel } from "@/features/settings/limits";
import { ModelPanel } from "@/features/settings/model";

const SECTIONS: TabItem<SettingsSection>[] = [
  { id: "model", label: "Model" },
  { id: "execution", label: "Execution" },
  { id: "limits", label: "Limits" },
  { id: "langfuse", label: "Langfuse" },
];

function Panel({ section }: { section: SettingsSection }) {
  switch (section) {
    case "model":
      return <ModelPanel />;
    case "execution":
      return <ExecutionPanel />;
    case "limits":
      return <LimitsPanel />;
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
