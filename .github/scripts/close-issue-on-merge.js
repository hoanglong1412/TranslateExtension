// When a PR is merged: move the linked issue from `status: in-progress` to `status: closed`
// and close it. Works for any base branch ("Closes #" only auto-closes into the default branch).
// Runs inside actions/github-script: module.exports = async ({ github, context, core }) => {...}

const { issueFromBranch, issueFromBody } = require('./issue-ref.js');

const FROM_LABEL = 'status: in-progress';
const TO_LABEL = 'status: closed';

module.exports = async ({ github, context, core }) => {
  const { owner, repo } = context.repo;
  const pr = context.payload.pull_request;

  // Branch name first, then "Closes #<id>" in the body
  const num = issueFromBranch(pr.head.ref) ?? issueFromBody(pr.body);
  if (!num) {
    core.info(`No linked issue found for PR #${pr.number} (branch "${pr.head.ref}"), skipping.`);
    return;
  }

  let issue;
  try {
    ({ data: issue } = await github.rest.issues.get({ owner, repo, issue_number: num }));
  } catch (e) {
    core.warning(`Issue #${num} not found (${e.message}), skipping.`);
    return;
  }
  if (issue.pull_request) {
    core.warning(`#${num} is a pull request, not an issue, skipping.`);
    return;
  }

  await github.rest.issues.addLabels({ owner, repo, issue_number: num, labels: [TO_LABEL] });
  await github.rest.issues
    .removeLabel({ owner, repo, issue_number: num, name: FROM_LABEL })
    .catch((e) => {
      if (e.status !== 404) core.warning(`Could not remove "${FROM_LABEL}" (${e.message})`);
    });

  if (issue.state !== 'closed') {
    await github.rest.issues.update({
      owner,
      repo,
      issue_number: num,
      state: 'closed',
      state_reason: 'completed',
    });
  }

  core.notice(`Issue #${num}: ${FROM_LABEL} -> ${TO_LABEL}, closed by PR #${pr.number}.`);
};
