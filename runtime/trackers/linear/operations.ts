import { historyLength } from "./read";

/**
 * Everything MemCode asks of Linear. Counts are stated in every list: Linear charges a
 * list by how many entries it may hold, 50 when nothing is said.
 */
const issueFields = `fragment IssueFields on Issue {
  id identifier url title description priority estimate dueDate updatedAt createdAt
  archivedAt trashed labelIds
  state { id }
  assignee { id name displayName email }
  team { id }
  cycle { id }
  project { id }
  projectMilestone { id }
  parent { id }
}`;
const commentFields = `fragment CommentFields on Comment {
  id body createdAt updatedAt archivedAt
  user { id name displayName }
  botActor { name }
  externalUser { name }
  parent { id }
  issue { id }
}`;
const page = "pageInfo { hasNextPage endCursor }";

export const operations = {
  Viewer: `query Viewer {
  viewer { id name displayName email }
  organization { id name urlKey }
}`,
  Teams: `query Teams($after: String) {
  teams(first: 50, after: $after) {
    nodes {
      id key name timezone cyclesEnabled
      issueEstimationType issueEstimationAllowZero issueEstimationExtended
    }
    ${page}
  }
}`,
  Statuses: `query Statuses($team: ID!) {
  workflowStates(first: 100, filter: { team: { id: { eq: $team } } }) {
    nodes { id name type position color }
  }
}`,
  People: `query People($team: String!, $after: String) {
  team(id: $team) {
    members(first: 100, after: $after) {
      nodes { id name displayName email active }
      ${page}
    }
  }
}`,
  Labels: `query Labels($team: ID!, $after: String) {
  issueLabels(
    first: 100
    after: $after
    filter: { or: [{ team: { id: { eq: $team } } }, { team: { null: true } }] }
  ) {
    nodes { id name isGroup parent { name } }
    ${page}
  }
}`,
  Cycles: `query Cycles($team: ID!, $after: String) {
  cycles(first: 50, after: $after, filter: { team: { id: { eq: $team } } }) {
    nodes {
      id number name description startsAt endsAt completedAt
      isActive isFuture isPast updatedAt archivedAt
    }
    ${page}
  }
}`,
  Projects: `query Projects($team: String!, $after: String) {
  team(id: $team) {
    projects(first: 25, after: $after) {
      nodes {
        id name description url sortOrder updatedAt archivedAt
        status { type }
        projectMilestones(first: 25) {
          nodes { id name description sortOrder updatedAt archivedAt status }
        }
      }
      ${page}
    }
  }
}`,
  IssueIds: `query IssueIds($filter: IssueFilter, $after: String) {
  issues(first: 250, after: $after, filter: $filter) {
    nodes { id cycle { id } }
    ${page}
  }
}`,
  Issues: `${issueFields}
query Issues($filter: IssueFilter, $after: String) {
  issues(
    first: 50
    after: $after
    filter: $filter
    orderBy: updatedAt
    includeArchived: true
  ) {
    nodes { ...IssueFields }
    ${page}
  }
}`,
  Issue: `${issueFields}
query Issue($id: String!) {
  issue(id: $id) { ...IssueFields }
}`,
  History: `query History($id: String!) {
  issue(id: $id) {
    history(first: ${historyLength}) {
      nodes {
        createdAt updatedDescription
        fromTitle toTitle fromPriority toPriority fromEstimate toEstimate
        fromDueDate toDueDate addedLabelIds removedLabelIds
        fromState { id } toState { id }
        fromAssignee { id } toAssignee { id }
        fromCycle { id } toCycle { id }
        fromProject { id } toProject { id }
        fromParent { id } toParent { id }
      }
    }
  }
}`,
  Standing: `query Standing($filter: IssueFilter, $after: String) {
  issues(first: 250, after: $after, filter: $filter, includeArchived: true) {
    nodes { id archivedAt trashed team { id } }
    ${page}
  }
}`,
  CommentsThere: `query CommentsThere($filter: CommentFilter, $after: String) {
  comments(first: 250, after: $after, filter: $filter, includeArchived: true) {
    nodes { id }
    ${page}
  }
}`,
  Comments: `${commentFields}
query Comments($filter: CommentFilter, $after: String) {
  comments(
    first: 50
    after: $after
    filter: $filter
    orderBy: updatedAt
    includeArchived: true
  ) {
    nodes { ...CommentFields }
    ${page}
  }
}`,
  UpdateIssue: `${issueFields}
mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) { success issue { ...IssueFields } }
}`,
  CreateIssue: `${issueFields}
mutation CreateIssue($input: IssueCreateInput!) {
  issueCreate(input: $input) { success issue { ...IssueFields } }
}`,
  CreateLabel: `mutation CreateLabel($input: IssueLabelCreateInput!) {
  issueLabelCreate(input: $input) { success issueLabel { id name } }
}`,
  CreateComment: `${commentFields}
mutation CreateComment($input: CommentCreateInput!) {
  commentCreate(input: $input) { success comment { ...CommentFields } }
}`,
  UpdateComment: `${commentFields}
mutation UpdateComment($id: String!, $input: CommentUpdateInput!) {
  commentUpdate(id: $id, input: $input) { success comment { ...CommentFields } }
}`,
  DeleteComment: `mutation DeleteComment($id: String!) {
  commentDelete(id: $id) { success }
}`,
  LinkPullRequest: `mutation LinkPullRequest($issue: String!, $url: String!) {
  attachmentLinkGitHubPR(issueId: $issue, url: $url) { success }
}`,
  LinkUrl: `mutation LinkUrl($issue: String!, $url: String!, $title: String) {
  attachmentLinkURL(issueId: $issue, url: $url, title: $title) { success }
}`,
  UpdateCycle: `mutation UpdateCycle($id: String!, $input: CycleUpdateInput!) {
  cycleUpdate(id: $id, input: $input) { success cycle { id endsAt } }
}`,
} as const;
export type Operation = keyof typeof operations;
