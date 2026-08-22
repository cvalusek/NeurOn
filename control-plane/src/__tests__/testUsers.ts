import type { AuthenticatedUser } from "../domain/types.js";

const MEMBER_PERMISSIONS = [
  "targets.read",
  "targets.use",
  "reservations.create",
  "reservations.manage_own",
  "profiles.manage_own",
  "api_keys.manage_own",
  "favorites.manage_own",
  "reports.read_own"
];

export function testUser(username = "clint", isAdmin = false): AuthenticatedUser {
  return {
    id: `usr_${username}`,
    username,
    isAdmin,
    permissions: isAdmin ? ["*"] : [...MEMBER_PERMISSIONS],
    sessionVersion: 1
  };
}
