import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

async function createGitHubIssue(title: string, description: string, currentPage: string | null) {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO || "Clarion1631/probuild";

  if (!token) {
    console.warn("[FeatureRequest] No GITHUB_TOKEN — skipping issue creation");
    return null;
  }

  const [owner, repoName] = repo.split("/");

  const body = [
    `## Feature Request`,
    ``,
    description,
    ``,
    `---`,
    `**Source:** Help Chat Widget`,
    currentPage ? `**Page:** \`${currentPage}\`` : "",
    `**Created:** ${new Date().toISOString()}`,
    ``,
    `> Auto-created from ProBuild in-app feature request`,
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
          title: `[Feature Request] ${title}`,
          body,
          labels: ["feature-request", "from-chat"],
        }),
      }
    );

    if (!res.ok) {
      const err = await res.text();
      console.error("[FeatureRequest] GitHub API error:", res.status, err);
      return null;
    }

    const issue = await res.json();
    return {
      number: issue.number as number,
      url: issue.html_url as string,
    };
  } catch (error) {
    console.error("[FeatureRequest] GitHub issue creation failed:", error);
    return null;
  }
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const role = (session.user as any).role;
  if (role !== "ADMIN") {
    return NextResponse.json(
      { error: "Admin access required" },
      { status: 403 }
    );
  }

  const { title, description, currentPage } = await req.json();
  const sessionUserId = (session.user as any).id;

  if (!title || !description) {
    return NextResponse.json(
      { error: "Missing required fields" },
      { status: 400 }
    );
  }

  try {
    // 1. Create GitHub Issue
    const ghIssue = await createGitHubIssue(title, description, currentPage);

    // 2. Save to HelpRequest table — use session userId so Requests tab can find it
    const result = await prisma.$queryRaw<any[]>`
      INSERT INTO "HelpRequest" (
        "userId", "type", "question", "response", "currentPage", "status"
      )
      VALUES (
        ${sessionUserId},
        'feature_request',
        ${title},
        ${description},
        ${currentPage || null},
        'open'
      )
      RETURNING *
    `;

    // 3. If GitHub issue was created, update the record with issue URL
    if (ghIssue && result[0]) {
      await prisma.$executeRaw`
        UPDATE "HelpRequest"
        SET "changeDescription" = ${`GitHub Issue #${ghIssue.number}`},
            "changeLocation" = ${ghIssue.url}
        WHERE "id" = ${result[0].id}::uuid
      `;
    }

    return NextResponse.json({
      request: result[0],
      githubIssue: ghIssue
        ? { number: ghIssue.number, url: ghIssue.url }
        : null,
    });
  } catch (error) {
    console.error("Feature request error:", error);
    return NextResponse.json(
      { error: "Failed to save request" },
      { status: 500 }
    );
  }
}
