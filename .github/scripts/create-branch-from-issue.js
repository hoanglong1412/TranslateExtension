// Creates a branch from an issue when the `status: approved` label is added.
// Runs inside actions/github-script: module.exports = async ({ github, context, core }) => {...}

const TRIGGER_LABEL = 'status: approved';
const DONE_LABEL = 'status: in-progress';

// Type label -> branch folder
const PREFIX_BY_LABEL = {
  bug: 'bugfix',
  enhancement: 'feature',
};

// Issue form field holding the base, formatted as "<branch> (<commit hash | latest>)"
const FIELD_VERSION = 'Software version';
const VERSION_RE = /^(\S+)\s*\(\s*([0-9a-f]{7,40}|latest)\s*\)$/i;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Read an issue form field value: "### <name>\n\n<value>" */
function readField(body, name) {
  const m = (body || '').match(new RegExp(`###\\s*${escapeRe(name)}\\s*\\n+([^\\n]+)`, 'i'));
  const v = m?.[1]
    .replace(/<!--.*?-->/g, '')
    .trim()
    .replace(/^`+|`+$/g, '');
  return v && v !== '_No response_' ? v : null;
}

/** Replace an issue form field value in the body */
function replaceField(body, name, value) {
  const re = new RegExp(`(###\\s*${escapeRe(name)}\\s*\\n+)([^\\n]+)`, 'i');
  return body.replace(re, (_, head) => `${head}${value}`);
}

/** Title -> ASCII slug (strips diacritics, including Vietnamese) */
function slugify(title) {
  return (
    title
      .replace(/^\[(feature|bug)\]\s*/i, '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/đ/gi, 'd')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/-+$/, '') || 'issue'
  );
}

module.exports = async ({ github, context, core }) => {
  const { owner, repo } = context.repo;
  const repoUrl = context.payload.repository.html_url;

  // Fetch the latest body (in case the issue was just edited)
  const { data: issue } = await github.rest.issues.get({
    owner,
    repo,
    issue_number: context.issue.number,
  });
  const num = issue.number;

  const comment = (body) =>
    github.rest.issues.createComment({ owner, repo, issue_number: num, body });

  const fail = async (msg) => {
    await comment(
      `❌ Could not create branch: ${msg}\n\nFix the issue, then add the \`${TRIGGER_LABEL}\` label again.`,
    );
    await github.rest.issues
      .removeLabel({ owner, repo, issue_number: num, name: TRIGGER_LABEL })
      .catch(() => {});
    core.setFailed(msg);
  };

  // 1. Branch folder from the type label
  const labels = issue.labels.map((l) => (typeof l === 'string' ? l : l.name));
  const typeLabel = Object.keys(PREFIX_BY_LABEL).find((l) => labels.includes(l));
  if (!typeLabel) {
    return fail(`issue is missing a ${Object.keys(PREFIX_BY_LABEL).map((l) => `\`${l}\``).join(' or ')} label.`);
  }
  const prefix = PREFIX_BY_LABEL[typeLabel];

  // 2. Read base branch / base commit from "<branch> (<hash | latest>)"
  const version = readField(issue.body, FIELD_VERSION);
  if (!version) return fail(`**${FIELD_VERSION}** is missing.`);
  const vm = version.match(VERSION_RE);
  if (!vm) {
    return fail(
      `**${FIELD_VERSION}** must look like \`main (0323417f...)\` — a branch followed by a commit hash ` +
        `(7–40 hex characters) or \`latest\` in parentheses, got \`${version}\`.`,
    );
  }
  const [, baseBranch, commitInput] = vm;
  const isLatest = /^latest$/i.test(commitInput);

  // 3. Base branch must exist
  let branchHead;
  try {
    const { data } = await github.rest.repos.getBranch({ owner, repo, branch: baseBranch });
    branchHead = data.commit.sha;
  } catch {
    return fail(`base branch \`${baseBranch}\` does not exist.`);
  }

  // 4. Resolve the full hash and check the commit is on the base branch
  let sha = branchHead;
  if (!isLatest) {
    try {
      const { data } = await github.rest.repos.getCommit({ owner, repo, ref: commitInput });
      sha = data.sha;
    } catch {
      return fail(`commit \`${commitInput}\` does not exist (or the short hash is ambiguous).`);
    }
    const { data: cmp } = await github.rest.repos.compareCommits({
      owner,
      repo,
      base: sha,
      head: baseBranch,
    });
    if (!['ahead', 'identical'].includes(cmp.status)) {
      return fail(`commit \`${sha.slice(0, 7)}\` is not in the history of \`${baseBranch}\`.`);
    }
  }

  // 5. No duplicates: skip if <prefix>/<num>-* already exists
  const { data: existing } = await github.rest.git.listMatchingRefs({
    owner,
    repo,
    ref: `heads/${prefix}/${num}-`,
  });
  if (existing.length) {
    const name = existing[0].ref.replace('refs/heads/', '');
    await comment(`ℹ️ This issue already has branch \`${name}\`, skipping.`);
    return;
  }

  // 6. Create the branch, linked to the issue's "Development" section (fallback: plain ref)
  const branch = `${prefix}/${num}-${slugify(issue.title)}`;
  try {
    await github.graphql(
      `mutation($issueId: ID!, $oid: GitObjectID!, $name: String!, $repoId: ID!) {
        createLinkedBranch(input: {issueId: $issueId, oid: $oid, name: $name, repositoryId: $repoId}) {
          linkedBranch { id }
        }
      }`,
      {
        issueId: issue.node_id,
        oid: sha,
        name: branch,
        repoId: context.payload.repository.node_id,
      },
    );
  } catch (e) {
    core.warning(`createLinkedBranch failed (${e.message}), falling back to createRef`);
    await github.rest.git.createRef({ owner, repo, ref: `refs/heads/${branch}`, sha });
  }

  // 7. Traceability: write the full hash back into the issue body
  const resolvedNote = isLatest ? ` <!-- resolved from "latest" at branch creation -->` : '';
  const newBody = replaceField(issue.body, FIELD_VERSION, `${baseBranch} (${sha})${resolvedNote}`);
  if (newBody !== issue.body) {
    await github.rest.issues.update({ owner, repo, issue_number: num, body: newBody });
  }

  // 8. Label + comment
  await github.rest.issues.addLabels({ owner, repo, issue_number: num, labels: [DONE_LABEL] });
  await comment(
    [
      `✅ Created branch [\`${branch}\`](${repoUrl}/tree/${encodeURI(branch)})`,
      '',
      '| | |',
      '|---|---|',
      `| Base branch | \`${baseBranch}\` |`,
      `| Base commit | [\`${sha}\`](${repoUrl}/commit/${sha})${isLatest ? ' (resolved from `latest`)' : ''} |`,
      '',
      '```bash',
      'git fetch origin',
      `git switch ${branch}`,
      '```',
      '',
      `When opening the PR, include \`Closes #${num}\` to close this issue automatically.`,
    ].join('\n'),
  );

  core.notice(`Created ${branch} @ ${sha}`);
};

// Exported for local testing
module.exports.slugify = slugify;
module.exports.readField = readField;
module.exports.replaceField = replaceField;
