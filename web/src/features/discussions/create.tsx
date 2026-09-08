import { useEffect, useId, useState } from "react";
import { useOrganization } from "../../app/organization";
import { Modal } from "../../components/ui/dialog";
import { Button, Field, Input } from "../../components/ui/index";
import { backend } from "../../lib/backend";
import { MemberPicker } from "./members";

export function CreateDiscussionDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (id: number) => void | Promise<void>;
}) {
  const { members, humanId } = useOrganization();
  const [topic, setTopic] = useState("");
  const [chosen, setChosen] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const topicId = useId();

  useEffect(() => {
    if (open) {
      setTopic("");
      setChosen([]);
    }
  }, [open]);

  const others = members.filter((member) => member.id !== humanId);
  const ready = topic.trim().length > 0 && chosen.length > 0;

  const create = async () => {
    if (!ready || busy) return;
    setBusy(true);
    try {
      const created = await backend.createDiscussion(topic.trim(), chosen);
      onOpenChange(false);
      await onCreated(created.id);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="New Discussion"
      description="One Discussion carries one topic. Pick at least one other Member; they can all read the whole history."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" disabled={!ready || busy} onClick={create}>
            Create Discussion
          </Button>
        </>
      }
    >
      <Field label="Topic" htmlFor={topicId}>
        <Input
          id={topicId}
          value={topic}
          placeholder="What is this Discussion about?"
          onChange={(event) => setTopic(event.target.value)}
        />
      </Field>
      <MemberPicker
        members={others}
        selected={chosen}
        onChange={setChosen}
        disabled={busy}
      />
    </Modal>
  );
}
