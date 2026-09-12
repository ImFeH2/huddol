import { useId, useState } from "react";
import { useOrganization } from "@/app/organization";
import { Modal } from "@/components/ui/dialog";
import { Avatar, Button, Chip, Input, toast } from "@/components/ui/index";
import { backend, type Member } from "@/lib/backend";

export function MemberPicker({
  members,
  selected,
  onChange,
  disabled = false,
}: {
  members: Member[];
  selected: number[];
  onChange: (selected: number[]) => void;
  disabled?: boolean;
}) {
  const id = useId();

  return (
    <fieldset className="member-picker" disabled={disabled}>
      <legend>Members</legend>
      <ul className="member-picker-list">
        {members.length === 0 ? (
          <li className="member-picker-empty muted">No other Members</li>
        ) : null}
        {members.map((member) => (
          <li key={member.id}>
            <label className="member-option" htmlFor={`${id}-${member.id}`}>
              <Input
                id={`${id}-${member.id}`}
                type="checkbox"
                checked={selected.includes(member.id)}
                onChange={(event) =>
                  onChange(
                    event.target.checked
                      ? [...selected, member.id]
                      : selected.filter((id) => id !== member.id),
                  )
                }
              />
              <Avatar name={member.name} size="sm" />
              <span className="member-option-name">{member.name}</span>
              <Chip tone={member.type === "agent" ? "blue" : "neutral"}>
                {member.type === "agent" ? "Agent" : "Human"}
              </Chip>
            </label>
          </li>
        ))}
      </ul>
    </fieldset>
  );
}

export function DiscussionMembersDialog({
  discussionId,
  memberIds,
  onClose,
  onSaved,
}: {
  discussionId: number;
  memberIds: number[];
  onClose: () => void;
  onSaved: (memberIds: number[]) => void | Promise<void>;
}) {
  const { members } = useOrganization();
  const [selected, setSelected] = useState(memberIds);
  const [busy, setBusy] = useState(false);
  const changed =
    selected.length !== memberIds.length ||
    selected.some((id) => !memberIds.includes(id));

  const save = async () => {
    if (!changed || busy) return;
    setBusy(true);
    try {
      const updated = await backend.setDiscussionMembers(
        discussionId,
        selected,
      );
      await onSaved(updated.member_ids);
      onClose();
    } catch (failure) {
      toast({
        tone: "danger",
        title: "Could not save",
        description:
          failure instanceof Error ? failure.message : String(failure),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
      title="Discussion members"
      footer={
        <>
          <Button disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!changed || busy} onClick={save}>
            Save
          </Button>
        </>
      }
    >
      <MemberPicker
        members={members}
        selected={selected}
        onChange={setSelected}
        disabled={busy}
      />
    </Modal>
  );
}
