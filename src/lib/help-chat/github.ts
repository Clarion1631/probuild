import { HELP_PROVIDER_TIMEOUT_MS } from "./submission-guard";

/**
 * The caller's absolute deadline when it has one, else a fresh per-call budget.
 *
 * An attempt that makes two calls passes ONE signal through both, so the pair
 * shares a single deadline instead of each starting its own clock.
 */
function providerSignal(signal?: AbortSignal): AbortSignal {
    return signal ?? AbortSignal.timeout(HELP_PROVIDER_TIMEOUT_MS);
}

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
  signal,
}: GitHubIssueOptions & { signal?: AbortSignal }): Promise<GitHubIssueResult | null> {
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
        // Bounded BELOW the provider lease: a call still running when the lease
        // expires has already been superseded by another claimant.
        signal: providerSignal(signal),
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


/**
 * Find an issue whose BODY carries a submission marker.
 *
 * Used only on a resume: the previous attempt's outcome is unknown by
 * definition, so it may have created the issue and died before recording it.
 * Searching for the marker before filing again is what stops one report
 * becoming two issues.
 *
 * A search failure returns null, which means "file it" — a duplicate issue is
 * an annoyance; a lost bug report is the thing this whole path exists to
 * prevent.
 */
export async function findIssueByMarker(marker: string, signal?: AbortSignal): Promise<GitHubIssueResult | null> {
    const token = process.env.GITHUB_TOKEN;
    const repo = process.env.GITHUB_REPO || "Clarion1631/probuild";
    if (!token) return null;
    const [owner, repoName] = repo.split("/");
    if (!owner || !repoName) return null;

    try {
        const query = encodeURIComponent(`repo:${owner}/${repoName} in:body "${marker}"`);
        const res = await fetch(`https://api.github.com/search/issues?q=${query}&per_page=1`, {
            signal: providerSignal(signal),
            headers: {
                Authorization: `Bearer ${token}`,
                Accept: "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
            },
        });
        if (!res.ok) return null;
        const found = await res.json();
        const issue = found?.items?.[0];
        if (!issue) return null;
        return { number: issue.number as number, url: issue.html_url as string };
    } catch (error) {
        console.error("[help-chat] marker search failed", error);
        return null;
    }
}
