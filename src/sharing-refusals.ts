/**
 * The rules the sharing service turns a request down by, and what MemCode tells
 * the person for each. The names are a contract with the service: it sends one
 * as `memsync-refusal` metadata. The wording is MemCode's own.
 */
export const refusalRules = [
  "no_such_project",
  "no_such_invitation",
  "no_such_guest",
  "only_the_owner_invites",
  "not_the_owner",
  "the_owner_cannot_leave",
  "guest_limit_reached",
  "too_many_projects",
  "already_on_project",
  "already_invited",
  "invitation_expired",
  "email_not_verified",
  "invalid_project_name",
  "invalid_email",
  "invalid_update_id",
  "empty_update",
  "update_too_large",
  "too_many_updates",
  "invalid_card_id",
  "file_too_large",
  "project_storage_full",
  "no_such_file",
  "unknown_readers",
  "unknown_link_code",
  "invalid_link_code",
] as const;
export type RefusalRule = (typeof refusalRules)[number];

export const isRefusalRule = (name: string): name is RefusalRule =>
  (refusalRules as readonly string[]).includes(name);

export const refusalSentences: Record<RefusalRule, string> = {
  no_such_project:
    "This shared project no longer exists, or you are no longer on it.",
  no_such_invitation:
    "That invitation is no longer open. Ask the owner of the project to invite you again.",
  no_such_guest: "That person is not a guest on this project.",
  only_the_owner_invites:
    "Only the owner of a project can invite people to it.",
  not_the_owner: "Only the owner of a project can change it.",
  the_owner_cannot_leave:
    "You own this project, so you cannot leave it. You can delete it at memtrace.io.",
  guest_limit_reached:
    "Every guest place on this project is taken. An invitation holds its place until it is accepted, cancelled or expires.",
  too_many_projects:
    "Your account already has 100 shared projects and Inboxes, which is the most it can have. Delete one at memtrace.io first.",
  already_on_project: "You are already on this project.",
  already_invited:
    "That email address already has an open invitation to this project.",
  invitation_expired:
    "This invitation has expired. Ask the owner of the project to send a new one.",
  email_not_verified:
    "Invitations go to a verified email address, and the one on your Memtrace account is not verified. Verify it at memtrace.io, then accept again.",
  invalid_project_name:
    "A project name is one line of text, at most 240 characters long.",
  invalid_email: "That is not an email address. Check it and try again.",
  invalid_update_id:
    "MemCode sent a board change without a usable id. This is a fault in MemCode, not something you did.",
  empty_update:
    "MemCode sent an empty board change. This is a fault in MemCode, not something you did.",
  update_too_large:
    "One change to the board was too large to share. Shorten the text you just added and try again.",
  too_many_updates:
    "MemCode sent too many board changes at once. This is a fault in MemCode, not something you did.",
  invalid_card_id:
    "MemCode named a card the sharing service cannot use. This is a fault in MemCode, not something you did.",
  file_too_large:
    "That file is larger than 5 MB, which is the most a project can share in one file.",
  project_storage_full:
    "This project already shares 50 MB of files, which is all it can keep. The file stays on this computer.",
  no_such_file:
    "That file is no longer kept for this project. Ask whoever shared it to share it again.",
  unknown_readers:
    "MemCode named readers for a card entry that the sharing service does not know. This is a fault in MemCode, not something you did.",
  unknown_link_code:
    "That code is used or more than 15 minutes old. Type /memcode link in the Slack channel again for a new one.",
  invalid_link_code:
    "That is not a code from /memcode link. It is 8 letters and digits, such as ABCD-EFGH.",
};
