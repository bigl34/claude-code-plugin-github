#!/usr/bin/env npx tsx
/**
 * GitHub Manager CLI
 *
 * Zod-validated CLI for GitHub operations via gh CLI.
 */

import { z, createCommand, runCli, cliTypes } from "@local/cli-utils";
import { execFileSync, spawnSync } from "child_process";

// =============================================================================
// TYPES
// =============================================================================

interface CommitNode {
  oid: string;
  message: string;
  author: {
    name: string;
    date: string;
  };
  additions: number;
  deletions: number;
  changedFilesIfAvailable: number | null;
}

interface GraphQLSingleCommitResponse {
  data: {
    repository: {
      object: {
        oid: string;
        message: string;
        author: {
          name: string;
          date: string;
        };
        additions: number;
        deletions: number;
        changedFilesIfAvailable: number | null;
        parents: {
          nodes: Array<{ oid: string }>;
        };
      };
    };
  };
  errors?: Array<{ message: string }>;
}

// =============================================================================
// UTILITIES
// =============================================================================

function parseRepoArg(repoArg: string): { owner: string; repo: string } {
  const parts = repoArg.split("/");
  if (parts.length !== 2) {
    throw new Error(`Invalid repo format: ${repoArg}. Expected owner/repo`);
  }
  return { owner: parts[0], repo: parts[1] };
}

function runGh(args: string[]): string {
  try {
    const result = execFileSync("gh", args, {
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
    });
    return result.trim();
  } catch (error: any) {
    if (error.stderr) {
      throw new Error(`gh command failed: ${error.stderr}`);
    }
    throw new Error(`gh command failed: ${error.message}`);
  }
}

function runGhGraphQL(query: string, variables: Record<string, any>): string {
  const queryOneLine = query.replace(/\n/g, " ").replace(/\s+/g, " ");
  const args: string[] = ["api", "graphql", "-f", `query=${queryOneLine}`];

  for (const [key, value] of Object.entries(variables)) {
    if (typeof value === "number") {
      args.push("-F", `${key}=${value}`);
    } else {
      args.push("-f", `${key}=${String(value)}`);
    }
  }

  try {
    const result = execFileSync("gh", args, {
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
    });
    return result;
  } catch (error: any) {
    throw new Error(`GitHub GraphQL query failed: ${error.message}`);
  }
}

// Dummy client class (gh CLI is the actual implementation)
class GitHubCLI {
  constructor() {}
}

// Define commands with Zod schemas
const commands = {
  // ==================== Repository Operations ====================
  "create-repo": createCommand(
    z.object({
      name: z.string().min(1).describe("Repository name"),
      private: z.boolean().optional().describe("Make repository private"),
      description: z.string().optional().describe("Repository description"),
    }),
    async (args) => {
      const cmdArgs = ["repo", "create", args.name as string, "--json", "name,url,private,description"];
      if (args.private) cmdArgs.push("--private");
      if (args.description) cmdArgs.push("--description", args.description as string);
      return JSON.parse(runGh(cmdArgs));
    },
    "Create a new repository"
  ),

  "fork-repo": createCommand(
    z.object({
      repo: z.string().min(1).describe("Repository (owner/name)"),
      org: z.string().optional().describe("Target organization"),
    }),
    async (args) => {
      const cmdArgs = ["repo", "fork", args.repo as string, "--clone=false", "--json", "name,url,owner"];
      if (args.org) cmdArgs.push("--org", args.org as string);
      return JSON.parse(runGh(cmdArgs));
    },
    "Fork a repository"
  ),

  "get-contents": createCommand(
    z.object({
      repo: z.string().min(1).describe("Repository (owner/name)"),
      path: z.string().min(1).describe("File path"),
      branch: z.string().optional().describe("Branch name"),
    }),
    async (args) => {
      const { owner, repo } = parseRepoArg(args.repo as string);
      let endpoint = `repos/${owner}/${repo}/contents/${args.path}`;
      if (args.branch) endpoint += `?ref=${args.branch}`;
      const result = runGh(["api", endpoint]);
      const data = JSON.parse(result);
      if (data.type === "file" && data.content) {
        data.decoded_content = Buffer.from(data.content, "base64").toString("utf-8");
      }
      return data;
    },
    "Get file/directory contents"
  ),

  "search-repos": createCommand(
    z.object({
      query: z.string().min(1).describe("Search query"),
      limit: cliTypes.int(1, 100).optional().describe("Max results (default: 10)"),
    }),
    async (args) => {
      const limit = (args.limit as number | undefined) || 10;
      const result = runGh([
        "search", "repos", args.query as string,
        "--json", "fullName,description,url,stargazersCount,updatedAt,visibility",
        "--limit", String(limit)
      ]);
      return JSON.parse(result);
    },
    "Search repositories"
  ),

  // ==================== Issue Operations ====================
  "list-issues": createCommand(
    z.object({
      repo: z.string().min(1).describe("Repository (owner/name)"),
      state: z.enum(["open", "closed", "all"]).optional().describe("Filter by state"),
      limit: cliTypes.int(1, 1000).optional().describe("Max results (default: 30)"),
    }),
    async (args) => {
      const cmdArgs = [
        "issue", "list",
        "--repo", args.repo as string,
        "--json", "number,title,state,author,labels,createdAt,updatedAt,url",
        "--limit", String((args.limit as number | undefined) || 30)
      ];
      if (args.state) cmdArgs.push("--state", args.state as string);
      return JSON.parse(runGh(cmdArgs));
    },
    "List issues"
  ),

  "get-issue": createCommand(
    z.object({
      repo: z.string().min(1).describe("Repository (owner/name)"),
      number: cliTypes.int(1).describe("Issue number"),
    }),
    async (args) => {
      const result = runGh([
        "issue", "view", String(args.number),
        "--repo", args.repo as string,
        "--json", "number,title,state,body,author,labels,assignees,milestone,createdAt,updatedAt,url,comments"
      ]);
      return JSON.parse(result);
    },
    "Get issue details"
  ),

  "create-issue": createCommand(
    z.object({
      repo: z.string().min(1).describe("Repository (owner/name)"),
      title: z.string().min(1).describe("Issue title"),
      body: z.string().optional().describe("Issue body"),
      labels: z.string().optional().describe("Comma-separated labels"),
    }),
    async (args) => {
      const cmdArgs = ["issue", "create", "--repo", args.repo as string, "--title", args.title as string];
      if (args.body) cmdArgs.push("--body", args.body as string);
      if (args.labels) cmdArgs.push("--label", args.labels as string);
      const result = runGh(cmdArgs);
      return { url: result, message: "Issue created" };
    },
    "Create an issue"
  ),

  "update-issue": createCommand(
    z.object({
      repo: z.string().min(1).describe("Repository (owner/name)"),
      number: cliTypes.int(1).describe("Issue number"),
      title: z.string().optional().describe("New title"),
      state: z.enum(["open", "closed"]).optional().describe("New state"),
      body: z.string().optional().describe("New body"),
    }),
    async (args) => {
      const repo = args.repo as string;
      const number = args.number as number;

      if (args.state === "closed") {
        runGh(["issue", "close", String(number), "--repo", repo]);
      } else if (args.state === "open") {
        runGh(["issue", "reopen", String(number), "--repo", repo]);
      }

      if (args.title || args.body) {
        const editArgs = ["issue", "edit", String(number), "--repo", repo];
        if (args.title) editArgs.push("--title", args.title as string);
        if (args.body) editArgs.push("--body", args.body as string);
        runGh(editArgs);
      }

      // Return updated issue
      const result = runGh([
        "issue", "view", String(number),
        "--repo", repo,
        "--json", "number,title,state,body,author,labels,assignees,milestone,createdAt,updatedAt,url,comments"
      ]);
      return JSON.parse(result);
    },
    "Update an issue"
  ),

  "add-comment": createCommand(
    z.object({
      repo: z.string().min(1).describe("Repository (owner/name)"),
      number: cliTypes.int(1).describe("Issue/PR number"),
      body: z.string().min(1).describe("Comment body"),
    }),
    async (args) => {
      runGh([
        "issue", "comment", String(args.number),
        "--repo", args.repo as string,
        "--body", args.body as string
      ]);
      return { success: true, issue: args.number, message: "Comment added" };
    },
    "Add comment to issue/PR"
  ),

  "search-issues": createCommand(
    z.object({
      query: z.string().min(1).describe("Search query"),
      limit: cliTypes.int(1, 1000).optional().describe("Max results (default: 30)"),
    }),
    async (args) => {
      const result = runGh([
        "search", "issues", args.query as string,
        "--json", "number,title,state,repository,author,createdAt,url",
        "--limit", String((args.limit as number | undefined) || 30)
      ]);
      return JSON.parse(result);
    },
    "Search issues"
  ),

  // ==================== Pull Request Operations ====================
  "list-prs": createCommand(
    z.object({
      repo: z.string().min(1).describe("Repository (owner/name)"),
      state: z.enum(["open", "closed", "all"]).optional().describe("Filter by state"),
      limit: cliTypes.int(1, 1000).optional().describe("Max results (default: 30)"),
    }),
    async (args) => {
      const cmdArgs = [
        "pr", "list",
        "--repo", args.repo as string,
        "--json", "number,title,state,author,headRefName,baseRefName,createdAt,updatedAt,url,isDraft",
        "--limit", String((args.limit as number | undefined) || 30)
      ];
      if (args.state) cmdArgs.push("--state", args.state as string);
      return JSON.parse(runGh(cmdArgs));
    },
    "List pull requests"
  ),

  "get-pr": createCommand(
    z.object({
      repo: z.string().min(1).describe("Repository (owner/name)"),
      number: cliTypes.int(1).describe("PR number"),
    }),
    async (args) => {
      const result = runGh([
        "pr", "view", String(args.number),
        "--repo", args.repo as string,
        "--json", "number,title,state,body,author,headRefName,baseRefName,labels,assignees,reviewRequests,reviews,createdAt,updatedAt,url,isDraft,mergeable,additions,deletions,changedFiles"
      ]);
      return JSON.parse(result);
    },
    "Get PR details"
  ),

  "create-pr": createCommand(
    z.object({
      repo: z.string().min(1).describe("Repository (owner/name)"),
      title: z.string().min(1).describe("PR title"),
      head: z.string().min(1).describe("Head branch"),
      base: z.string().min(1).describe("Base branch"),
      body: z.string().optional().describe("PR body"),
      draft: z.boolean().optional().describe("Create as draft"),
    }),
    async (args) => {
      const cmdArgs = [
        "pr", "create",
        "--repo", args.repo as string,
        "--title", args.title as string,
        "--head", args.head as string,
        "--base", args.base as string
      ];
      if (args.body) cmdArgs.push("--body", args.body as string);
      if (args.draft) cmdArgs.push("--draft");
      const result = runGh(cmdArgs);
      return { url: result, message: "PR created" };
    },
    "Create a pull request"
  ),

  "merge-pr": createCommand(
    z.object({
      repo: z.string().min(1).describe("Repository (owner/name)"),
      number: cliTypes.int(1).describe("PR number"),
      method: z.enum(["merge", "squash", "rebase"]).optional().describe("Merge method"),
    }),
    async (args) => {
      const cmdArgs = [
        "pr", "merge", String(args.number),
        "--repo", args.repo as string,
        "--delete-branch"
      ];
      const method = args.method as string | undefined;
      if (method === "squash") cmdArgs.push("--squash");
      else if (method === "rebase") cmdArgs.push("--rebase");
      else cmdArgs.push("--merge");
      runGh(cmdArgs);
      return { success: true, pr: args.number, message: `PR merged via ${method || "merge"}` };
    },
    "Merge a pull request"
  ),

  "create-review": createCommand(
    z.object({
      repo: z.string().min(1).describe("Repository (owner/name)"),
      number: cliTypes.int(1).describe("PR number"),
      event: z.enum(["APPROVE", "COMMENT", "REQUEST_CHANGES"]).describe("Review event"),
      body: z.string().optional().describe("Review body"),
    }),
    async (args) => {
      const cmdArgs = ["pr", "review", String(args.number), "--repo", args.repo as string];
      const event = args.event as string;
      if (event === "APPROVE") cmdArgs.push("--approve");
      else if (event === "REQUEST_CHANGES") cmdArgs.push("--request-changes");
      else cmdArgs.push("--comment");
      if (args.body) cmdArgs.push("--body", args.body as string);
      runGh(cmdArgs);
      return { success: true, pr: args.number, event, message: "Review submitted" };
    },
    "Create a PR review"
  ),

  "get-pr-files": createCommand(
    z.object({
      repo: z.string().min(1).describe("Repository (owner/name)"),
      number: cliTypes.int(1).describe("PR number"),
    }),
    async (args) => {
      const { owner, repo } = parseRepoArg(args.repo as string);
      const result = runGh(["api", `repos/${owner}/${repo}/pulls/${args.number}/files`]);
      return JSON.parse(result);
    },
    "Get PR changed files"
  ),

  "get-pr-status": createCommand(
    z.object({
      repo: z.string().min(1).describe("Repository (owner/name)"),
      number: cliTypes.int(1).describe("PR number"),
    }),
    async (args) => {
      const result = runGh([
        "pr", "view", String(args.number),
        "--repo", args.repo as string,
        "--json", "number,state,mergeable,mergeStateStatus,statusCheckRollup,reviews"
      ]);
      return JSON.parse(result);
    },
    "Get PR status and checks"
  ),

  "update-pr-branch": createCommand(
    z.object({
      repo: z.string().min(1).describe("Repository (owner/name)"),
      number: cliTypes.int(1).describe("PR number"),
    }),
    async (args) => {
      const { owner, repo } = parseRepoArg(args.repo as string);
      const result = runGh([
        "api", "-X", "PUT",
        `repos/${owner}/${repo}/pulls/${args.number}/update-branch`
      ]);
      return { success: true, pr: args.number, message: "Branch updated", ...JSON.parse(result) };
    },
    "Update PR branch from base"
  ),

  // ==================== Branch Operations ====================
  "create-branch": createCommand(
    z.object({
      repo: z.string().min(1).describe("Repository (owner/name)"),
      branch: z.string().min(1).describe("New branch name"),
      from: z.string().optional().describe("Source branch (default: main)"),
    }),
    async (args) => {
      const { owner, repo } = parseRepoArg(args.repo as string);
      const sourceRef = (args.from as string | undefined) || "main";
      const refResult = runGh(["api", `repos/${owner}/${repo}/git/refs/heads/${sourceRef}`]);
      const refData = JSON.parse(refResult);
      const sha = refData.object.sha;

      const result = runGh([
        "api", "-X", "POST",
        `repos/${owner}/${repo}/git/refs`,
        "-f", `ref=refs/heads/${args.branch}`,
        "-f", `sha=${sha}`
      ]);
      return { success: true, branch: args.branch, sha, source: sourceRef, ...JSON.parse(result) };
    },
    "Create a new branch"
  ),

  // ==================== File Operations ====================
  "push-files": createCommand(
    z.object({
      repo: z.string().min(1).describe("Repository (owner/name)"),
      branch: z.string().min(1).describe("Target branch"),
      message: z.string().min(1).describe("Commit message"),
      files: z.string().min(1).describe('JSON array: [{"path":"...","content":"..."}]'),
    }),
    async (args) => {
      const { owner, repo } = parseRepoArg(args.repo as string);
      const branch = args.branch as string;
      const message = args.message as string;
      const files = JSON.parse(args.files as string) as Array<{ path: string; content: string }>;

      const refResult = runGh(["api", `repos/${owner}/${repo}/git/refs/heads/${branch}`]);
      const refData = JSON.parse(refResult);
      const parentSha = refData.object.sha;

      const commitResult = runGh(["api", `repos/${owner}/${repo}/git/commits/${parentSha}`]);
      const commitData = JSON.parse(commitResult);
      const baseTreeSha = commitData.tree.sha;

      const treeItems: Array<{ path: string; mode: string; type: string; sha: string }> = [];

      for (const file of files) {
        const contentBase64 = Buffer.from(file.content).toString("base64");
        const blobResult = runGh([
          "api", "-X", "POST",
          `repos/${owner}/${repo}/git/blobs`,
          "-f", `content=${contentBase64}`,
          "-f", "encoding=base64"
        ]);
        const blobData = JSON.parse(blobResult);
        treeItems.push({
          path: file.path,
          mode: "100644",
          type: "blob",
          sha: blobData.sha
        });
      }

      const treePayload = JSON.stringify({ base_tree: baseTreeSha, tree: treeItems });
      const treeResult = spawnSync("gh", [
        "api", "-X", "POST",
        `repos/${owner}/${repo}/git/trees`,
        "--input", "-"
      ], { input: treePayload, encoding: "utf-8" });

      if (treeResult.error) throw new Error(`Failed to create tree: ${treeResult.error.message}`);
      if (treeResult.status !== 0) throw new Error(`Failed to create tree: ${treeResult.stderr}`);
      const treeData = JSON.parse(treeResult.stdout);

      const commitPayload = JSON.stringify({ message, tree: treeData.sha, parents: [parentSha] });
      const newCommitResult = spawnSync("gh", [
        "api", "-X", "POST",
        `repos/${owner}/${repo}/git/commits`,
        "--input", "-"
      ], { input: commitPayload, encoding: "utf-8" });

      if (newCommitResult.error) throw new Error(`Failed to create commit: ${newCommitResult.error.message}`);
      if (newCommitResult.status !== 0) throw new Error(`Failed to create commit: ${newCommitResult.stderr}`);
      const newCommitData = JSON.parse(newCommitResult.stdout);

      runGh([
        "api", "-X", "PATCH",
        `repos/${owner}/${repo}/git/refs/heads/${branch}`,
        "-f", `sha=${newCommitData.sha}`
      ]);

      return { success: true, commit: newCommitData.sha, message, files: files.map(f => f.path) };
    },
    "Push files to a branch"
  ),

  // ==================== Code Search ====================
  "search-code": createCommand(
    z.object({
      query: z.string().min(1).describe("Search query"),
      limit: cliTypes.int(1, 1000).optional().describe("Max results (default: 30)"),
    }),
    async (args) => {
      const result = runGh([
        "search", "code", args.query as string,
        "--json", "path,repository,textMatches",
        "--limit", String((args.limit as number | undefined) || 30)
      ]);
      return JSON.parse(result);
    },
    "Search code"
  ),

  // ==================== Commit Operations ====================
  "list-commits": createCommand(
    z.object({
      repo: z.string().min(1).describe("Repository (owner/name)"),
      limit: cliTypes.int(1, 100).optional().describe("Max results (default: 10)"),
      branch: z.string().optional().describe("Branch name"),
    }),
    async (args) => {
      const { owner, repo } = parseRepoArg(args.repo as string);
      const limit = (args.limit as number | undefined) || 10;
      const branch = args.branch as string | undefined;

      const query = branch ? `
        query($owner: String!, $repo: String!, $first: Int!) {
          repository(owner: $owner, name: $repo) {
            ref(qualifiedName: "refs/heads/${branch}") {
              target {
                ... on Commit {
                  history(first: $first) {
                    nodes { oid message author { name date } additions deletions changedFilesIfAvailable }
                  }
                }
              }
            }
          }
        }
      ` : `
        query($owner: String!, $repo: String!, $first: Int!) {
          repository(owner: $owner, name: $repo) {
            defaultBranchRef {
              target {
                ... on Commit {
                  history(first: $first) {
                    nodes { oid message author { name date } additions deletions changedFilesIfAvailable }
                  }
                }
              }
            }
          }
        }
      `;

      const resultJson = runGhGraphQL(query, { owner, repo, first: limit });
      const result = JSON.parse(resultJson);

      if (result.errors) {
        throw new Error(`GraphQL Errors: ${JSON.stringify(result.errors)}`);
      }

      const history = branch
        ? result.data.repository.ref?.target?.history
        : result.data.repository.defaultBranchRef?.target?.history;

      if (!history) {
        throw new Error("No commit history found");
      }

      const commits = history.nodes.map((node: CommitNode) => ({
        sha: node.oid,
        shortSha: node.oid.substring(0, 7),
        message: node.message.split("\n")[0],
        author: node.author.name,
        date: node.author.date,
        additions: node.additions,
        deletions: node.deletions,
        changedFiles: node.changedFilesIfAvailable,
      }));

      return { commits };
    },
    "List commits"
  ),

  "get-commit": createCommand(
    z.object({
      repo: z.string().min(1).describe("Repository (owner/name)"),
      sha: z.string().min(1).describe("Commit SHA"),
    }),
    async (args) => {
      const { owner, repo } = parseRepoArg(args.repo as string);
      const sha = args.sha as string;

      const query = `
        query($owner: String!, $repo: String!, $sha: GitObjectID!) {
          repository(owner: $owner, name: $repo) {
            object(oid: $sha) {
              ... on Commit {
                oid message author { name date }
                additions deletions changedFilesIfAvailable
                parents(first: 5) { nodes { oid } }
              }
            }
          }
        }
      `;

      const resultJson = runGhGraphQL(query, { owner, repo, sha });
      const result: GraphQLSingleCommitResponse = JSON.parse(resultJson);

      if (result.errors) {
        throw new Error(`GraphQL Errors: ${JSON.stringify(result.errors)}`);
      }

      const commit = result.data.repository.object;
      if (!commit) {
        throw new Error(`Commit ${sha} not found`);
      }

      return {
        sha: commit.oid,
        shortSha: commit.oid.substring(0, 7),
        message: commit.message,
        author: commit.author.name,
        date: commit.author.date,
        additions: commit.additions,
        deletions: commit.deletions,
        changedFiles: commit.changedFilesIfAvailable,
        parents: commit.parents.nodes.map((p) => p.oid),
      };
    },
    "Get commit details"
  ),
};

// Run CLI
runCli(commands, GitHubCLI, {
  programName: "github-cli",
  description: "GitHub operations via gh CLI",
});
