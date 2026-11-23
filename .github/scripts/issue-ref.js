// Helpers shared by the PR workflows: find the issue a PR belongs to.

// Branch naming convention: <feature|bugfix|task>/<issue>-<slug>
const BRANCH_RE = /^(feature|bugfix|task)\/(\d+)-/;

// "Closes #12" (also Fixes / Resolves, any case) anywhere in the PR body
const CLOSES_RE = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/i;

/** Issue number from a branch name, or null if it doesn't follow the convention */
function issueFromBranch(branch) {
  const m = (branch || '').match(BRANCH_RE);
  return m ? Number(m[2]) : null;
}

/** Issue number from a "Closes #<id>" keyword in the PR body, or null */
function issueFromBody(body) {
  const m = (body || '').match(CLOSES_RE);
  return m ? Number(m[1]) : null;
}

module.exports = { BRANCH_RE, CLOSES_RE, issueFromBranch, issueFromBody };
