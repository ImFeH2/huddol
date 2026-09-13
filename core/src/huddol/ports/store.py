from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Protocol

from huddol.core.discussion import Discussion, Message
from huddol.core.member import AgentState, Member, MemberType
from huddol.core.mention import Mention


class OrganizationStore(Protocol):
    def list_members(self, *, include_deleted: bool = False) -> tuple[Member, ...]: ...

    def get_member(self, member_id: int) -> Member | None: ...

    def name_taken(self, name: str) -> bool: ...

    def create_member(self, member_type: MemberType, name: str) -> Member: ...

    def rename_member(self, member_id: int, name: str) -> Member: ...

    def set_agent_state(self, agent_id: int, state: AgentState) -> None: ...

    def delete_member(self, member_id: int) -> None: ...

    def list_discussions(
        self,
        *,
        member_id: int | None = None,
        include_archived: bool = False,
        limit: int | None = None,
    ) -> tuple[Discussion, ...]: ...

    def get_discussion(self, discussion_id: int) -> Discussion | None: ...

    def create_discussion(
        self, topic: str, member_ids: Sequence[int]
    ) -> Discussion: ...

    def set_discussion_members(
        self, discussion_id: int, member_ids: Sequence[int]
    ) -> Discussion: ...

    def change_discussion_members(
        self, discussion_id: int, member_ids: Sequence[int], *, remove: bool = False
    ) -> Discussion: ...

    def set_archived(self, discussion_id: int, archived: bool) -> None: ...

    def append_message(
        self, discussion_id: int, sender_id: int, body: str
    ) -> tuple[Message, tuple[Mention, ...]]: ...

    def messages(
        self,
        discussion_id: int,
        *,
        after: int | None = None,
        before: int | None = None,
        limit: int | None = None,
        latest: bool = False,
    ) -> tuple[Message, ...]: ...

    def message_count(self, discussion_id: int) -> int: ...

    def mentions_by_message(
        self, discussion_id: int
    ) -> Mapping[int, frozenset[int]]: ...

    def search_messages(
        self,
        query: str,
        *,
        sender_id: int | None = None,
        discussion_id: int | None = None,
        limit: int = 50,
    ) -> tuple[Message, ...]: ...

    def pending(self, member_id: int) -> tuple[Mention, ...]: ...

    def ack(
        self, discussion_id: int, message_ids: Sequence[int], member_id: int
    ) -> int: ...

    def acknowledged(self, discussion_id: int, member_id: int) -> tuple[int, ...]: ...

    def revoke_ack(
        self, discussion_id: int, message_ids: Sequence[int], member_id: int
    ) -> int: ...

    def watermark(self, discussion_id: int, member_id: int) -> int: ...

    def set_watermark(
        self, discussion_id: int, member_id: int, message_id: int
    ) -> None: ...

    def unread_counts(self, member_id: int) -> Mapping[int, int]: ...
