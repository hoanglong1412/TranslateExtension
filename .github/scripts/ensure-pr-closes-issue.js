// Makes sure the PR body starts with "Closes #<id>", where <id> comes from the branch name.
// Runs inside actions/github-script: module.exports = async ({ github, context, core }) => {...}

const { issueFromBranch } = require('./issue-ref.js');

// First line of the template, with or without a number: "Closes #" / "Closes #12"
const FIRST_LINE_RE = /^closes\s+#(\d*)\s*$/i;

/**
 * Returns the new body, or null when nothing needs to change.
 * - first line "Closes #<id>"      -> unchanged
 * - first line "Closes #" (empty)  -> filled with <id>
 * - anything else                  -> "Closes #<id>" prepended
 */
function ensureClosesLine(body, id) {
  const text = (body || '').replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  const first = lines.findIndex((l) => l.trim() !== '');
  const line = `Closes #${id}`;

  if (first !== -1) {
    const m = lines[first].trim().match(FIRST_LINE_RE);
    if (m && m[1] === String(id)) return null;
    if (m && m[1] === '') {
      lines[first] = line;
      return lines.slice(first).join('\n');
    }
  }
  return text.trim() ? `${line}\n\n${text}` : line;
}

module.exports = async ({ github, context, core }) => {
  const pr = context.payload.pull_request;
  const id = issueFromBranch(pr.head.ref);
  if (!id) {
    core.info(`Branch "${pr.head.ref}" does not follow <type>/<issue>-<slug>, skipping.`);
    return;
  }

  const newBody = ensureClosesLine(pr.body, id);
  if (newBody === null) {
    core.info(`PR body already starts with "Closes #${id}".`);
    return;
  }

  const { owner, repo } = context.repo;
  try {
    await github.rest.pulls.update({ owner, repo, pull_number: pr.number, body: newBody });
    core.notice(`PR #${pr.number}: body now starts with "Closes #${id}".`);
  } catch (e) {
    // e.g. PRs from forks get a read-only token
    core.warning(`Could not update PR body (${e.message}). Add "Closes #${id}" manually.`);
  }
};

// Exported for local testing
module.exports.ensureClosesLine = ensureClosesLine;
