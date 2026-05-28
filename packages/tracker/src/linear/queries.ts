/** Shared issue field selection for normalization. */
export const ISSUE_FIELDS = `
  id
  identifier
  title
  description
  priority
  branchName
  url
  state { name }
  labels { nodes { name } }
  inverseRelations { nodes { type issue { id identifier state { name } } } }
  createdAt
  updatedAt
`;

export const ISSUES_BY_PROJECT_AND_STATES = `
  query SymphonyCandidates($slug: String!, $states: [String!], $after: String) {
    issues(
      first: 50
      after: $after
      filter: { project: { slugId: { eq: $slug } }, state: { name: { in: $states } } }
    ) {
      nodes { ${ISSUE_FIELDS} }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

export const ISSUES_BY_STATES = `
  query SymphonyByStates($slug: String!, $states: [String!], $after: String) {
    issues(
      first: 50
      after: $after
      filter: { project: { slugId: { eq: $slug } }, state: { name: { in: $states } } }
    ) {
      nodes { ${ISSUE_FIELDS} }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

export const ISSUE_STATES_BY_IDS = `
  query SymphonyStates($ids: [ID!]) {
    issues(first: 250, filter: { id: { in: $ids } }) {
      nodes { id identifier state { name } }
    }
  }
`;

export const CREATE_ISSUE = `
  mutation SymphonyCreateIssue($input: IssueCreateInput!) {
    issueCreate(input: $input) {
      success
      issue { id identifier title description priority branchName url state { name } createdAt updatedAt }
    }
  }
`;

export const PROJECT_BY_SLUG = `
  query SymphonyProject($slug: String!) {
    issues(first: 1, filter: { project: { slugId: { eq: $slug } } }) {
      nodes { id }
    }
  }
`;

export const WORKFLOW_STATES_BY_PROJECT = `
  query SymphonyStatesList($slug: String!) {
    workflowStates(first: 100, filter: { team: { projects: { slugId: { eq: $slug } } } }) {
      nodes { id name type }
    }
  }
`;
