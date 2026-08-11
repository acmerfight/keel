export type Role = "guest" | "staff";

export function canDelete(role: Role): boolean {
  return role === "staff";
}
