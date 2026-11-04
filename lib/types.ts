export type User = { id: string; name: string; email: string; color: string };
export type Member = { userId: string; name: string; role: string; share: number };
export type Panel = { image: string; dialogue: string; alt: string };
export type Project = {
  id: string; title: string; description: string; ownerId: string; theme: string;
  genre: string; members: Member[]; panels: Panel[]; state: "draft" | "review" | "published";
  revision: number; version: number; approvals: string[]; terms: string;
  rosterFrozen: boolean; createdAt: string; updatedAt: string; publishedAt?: string;
  events: { id: string; text: string; at: string }[]; sample?: boolean;
};
export type Invitation = { id: string; projectId: string; email: string; expiresAt: string; accepted: boolean };
export type AppData = { user: User | null; projects: Project[]; comics: Project[] };
