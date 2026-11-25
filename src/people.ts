/** Someone a task can belong to: a person in the tracker the project is connected to. */
export interface Person {
  id: string;
  name: string;
  email?: string;
}

export const initials = (name: string): string =>
  name
    .split(/[\s._-]+/)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase())
    .slice(0, 2)
    .join("") || "?";
