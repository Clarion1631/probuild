interface GitHubIssueOptions {
  title: string;
  description: string;
  currentPage?: string | null;
  labelPrefix: string;
  labels: string[];
  metadata?: string[];
}

export interface GitHubIssueResult {
  number: number;
  url: string;
}

export async function createHelpChatGitHubIssue({
  title,
  description,
  currentPage,
  labelPrefix,
  labels,
  metadata = [],
}: GitHubIssueOptions): Promise<GitHubIssueResult | null> {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO || "Clarion1631/probuild";

  if (!token) {
    console.warn(`[${labelPrefix}] No GITHUB_TOKEN - skipping issue creation`);
    return null;
  }

  const [owner, repoName] = repo.split("/");
  if (!owner || !repoName) {
    console.error(`[${labelPrefix}] Invalid GITHUB_REPO value: ${repo}`);
    return null;
  }

  const body = [
    `## ${labelPrefix}`,
    "",
    description,
    "",
    "---",
    "**Source:** Help Chat Widget",
    currentPage ? `**Page:** \`${currentPage}\`` : "",
    `**Created:** ${new Date().toISOString()}`,
    ...metadata,
    "",
    `> Auto-created from ProBuild in-app ${labelPrefix.toLowerCase()}`,
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repoName}/issues`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          title: `[${labelPrefix}] ${title}`,
          body,
          labels,
        }),
      }
    );

    if (!res.ok) {
      const err = await res.text();
      console.error(`[${labelPrefix}] GitHub API error:`, res.status, err);
      return null;
    }

    const issue = await res.json();
    return {
      number: issue.number as number,
      url: issue.html_url as string,
    };
  } catch (error) {
    console.error(`[${labelPrefix}] GitHub issue creation failed:`, error);
    return null;
  }
}
