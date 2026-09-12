import { useEffect, useId, useState } from "react";
import { useOrganization } from "@/app/organization";
import { Modal } from "@/components/ui/dialog";
import { Button, Field, Input, toast } from "@/components/ui/index";
import { MemberPicker } from "@/features/discussions/members";
import { backend } from "@/lib/backend";

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
    } catch (failure) {
      toast({
        tone: "danger",
        title: "Could not create Discussion",
        description:
          failure instanceof Error ? failure.message : String(failure),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="New Discussion"
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
