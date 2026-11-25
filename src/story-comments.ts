export interface StoryAuthor {
  id: string;
  name: string;
  /** "linear" is someone who wrote there, with or without a place on the project here. */
  source: "memtrace" | "local" | "linear";
}
export interface StoryComment {
  /** Portable selection for a review explicitly shared with the team. */
  reference?: import("./team").TeamReference;
  id: string;
  taskId: string;
  text: string;
  author: StoryAuthor;
  parentId?: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
  /** The comment this is in the connected tracker. */
  tracker?: import("./tracker").TrackedItem;
}
