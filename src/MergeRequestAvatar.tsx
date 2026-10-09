import { Avatar } from "./App";
import { authorColor, authorInitials } from "./git";
import type { MrUser } from "./mergeRequestTypes";

export function MergeRequestAvatar({ user, size = 27 }: { user: MrUser; size?: number }) {
  const identity = user.email?.trim() || user.publicEmail?.trim() || `gitlab:${user.id}`;
  return <span className="gkm-avatar" style={{ width: size, height: size }} aria-hidden="true">
    <Avatar author={{ initials: authorInitials(user.name || user.username), color: authorColor(identity) }} size={size} />
  </span>;
}
