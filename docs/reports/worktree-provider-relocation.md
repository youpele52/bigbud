# Worktree lifecycle scope

The former provider-native relocation proposal is superseded. bigbud lists and
creates linked worktrees, switches eligible inactive chats, and deletes only clean,
unreferenced, inactive linked checkouts after confirmation. Remote mutations have
no local fallback. Agents use existing terminal tools for broader Git management;
there is no dedicated agent worktree or native provider relocation protocol.

Inventory refresh detects external changes. An inactive chat without retained
native history can follow an exact saved filesystem identity to its new Git-listed
path through canonical metadata events. Missing, replaced, ambiguous, active, or
native-history-bound workspaces are reported without clearing history/cursors or
creating replacement conversations. External moves do not guarantee native resume.

Applied migrations 130, 131 and the forward repair 132 remain registered. The old
provider-relocation tables remain inert. Unfinished legacy rename operations retain
their reservations and require manual review; startup does not retry their physical
or provider operations. Never rewrite applied migrations or test on real user data.
