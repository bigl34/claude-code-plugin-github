#!/usr/bin/env npx tsx

import {
  z,
  createCommand,
  runCli,
  cliTypes,
  wrapUntrustedField,
  buildSafeOutput,
  TRUNCATION_DEFAULTS,
} from "@local/cli-utils";
import { execFileSync, spawnSync } from "child_process";
import {
  extractLogin,
  wrapIssueOrPrDetail,
} from "./wrap.js";
import { fileURLToPath } from "url";


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


function parseRepoArg(repoArg: string): { owner: string; repo: string } {
  const parts = repoArg.split("/");
  if (parts.length !== 2) {
    throw new Error(`Invalid repo format: ${repoArg}. Expected owner/repo`);
  }
  return { owner: parts[0], repo: parts[1] };
}

type GhRunner = (args: string[]) => string;

function defaultRunGh(args: string[]): string {
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

let ghRunner: GhRunner = defaultRunGh;

export function setRunGhForTests(runner: GhRunner | null): void {
  ghRunner = runner ?? defaultRunGh;
}

function runGh(args: string[]): string {
  return ghRunner(args);
}

function parseJson<T>(text: string, context: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new Error(`${context}: failed to parse gh JSON output: ${error instanceof Error ? error.message : String(error)}`);
  }
}

interface RepoView {
  name?: string;
  url?: string;
  visibility?: string;
  description?: string | null;
  owner?: { login?: string } | string | null;
}

function repoNameFromFullName(fullName: string): string {
  return fullName.includes("/") ? fullName.split("/").pop()! : fullName;
}

function getRepoView(repo: string, attempts = 3): RepoView {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return parseJson<RepoView>(
        runGh(["repo", "view", repo, "--json", "name,url,visibility,description,owner"]),
        `gh repo view ${repo}`,
      );
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function ownerLoginFromRepoView(data: RepoView): string {
  if (typeof data.owner === "object" && data.owner != null) return data.owner.login ?? "";
  return String(data.owner ?? "");
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

class GitHubCLI {
  constructor() {}
}

export const commands = {
  "create-repo": createCommand(
    z.object({
      name: z.string().min(1).describe("Repository name"),
      private: z.boolean().optional().describe("Make repository private"),
      description: z.string().optional().describe("Repository description"),
    }),
    async (args) => {
      const cmdArgs = ["repo", "create", args.name as string, args.private ? "--private" : "--public"];
      if (args.description) cmdArgs.push("--description", args.description as string);
      runGh(cmdArgs);
      const data = getRepoView(args.name as string);
      return buildSafeOutput(
        {
          command: "create-repo",
          name: data.name,
          url: data.url,
          private: data.visibility === "PRIVATE",
        },
        {
          description: wrapUntrustedField(
            "description",
            data.description ?? "",
            { maxChars: TRUNCATION_DEFAULTS.body }
          ),
        }
      );
    },
    "Create a new repository",
    { sideEffect: "write" }
  ),

  "fork-repo": createCommand(
    z.object({
      repo: z.string().min(1).describe("Repository (owner/name)"),
      org: z.string().optional().describe("Target organization"),
    }),
    async (args) => {
      const sourceRepo = args.repo as string;
      const cmdArgs = ["repo", "fork", sourceRepo, "--clone=false"];
      if (args.org) cmdArgs.push("--org", args.org as string);
      runGh(cmdArgs);
      const targetOwner = args.org
        ? args.org as string
        : runGh(["api", "user", "--jq", ".login"]);
      const data = getRepoView(`${targetOwner}/${repoNameFromFullName(sourceRepo)}`);
      const ownerLogin = ownerLoginFromRepoView(data);
      return buildSafeOutput(
        {
          command: "fork-repo",
          name: data.name,
          url: data.url,
        },
        {
          owner: {
            login: wrapUntrustedField(
              "owner.login",
              ownerLogin,
              { maxChars: TRUNCATION_DEFAULTS.displayName }
            ),
          },
        }
      );
    },
    "Fork a repository",
    { sideEffect: "write" }
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

      if (Array.isArray(data)) {
        const entries = data.map((entry: any, i: number) => ({
          type: entry.type,
          size: entry.size,
          sha: entry.sha,
          url: entry.url,
          name: wrapUntrustedField(
            `entries[${i}].name`,
            entry.name ?? "",
            { maxChars: TRUNCATION_DEFAULTS.subject }
          ),
          path: wrapUntrustedField(
            `entries[${i}].path`,
            entry.path ?? "",
            { maxChars: TRUNCATION_DEFAULTS.subject }
          ),
        }));
        return buildSafeOutput(
          {
            command: "get-contents",
            repo: args.repo,
            kind: "directory",
            count: entries.length,
          },
          { entries }
        );
      }

      let decodedContent = "";
      if (data.type === "file" && data.content) {
        decodedContent = Buffer.from(data.content, "base64").toString("utf-8");
      }
      return buildSafeOutput(
        {
          command: "get-contents",
          repo: args.repo,
          kind: "file",
          type: data.type,
          size: data.size,
          sha: data.sha,
          url: data.url,
          encoding: data.encoding,
        },
        {
          name: wrapUntrustedField(
            "name",
            data.name ?? "",
            { maxChars: TRUNCATION_DEFAULTS.subject }
          ),
          path: wrapUntrustedField(
            "path",
            data.path ?? "",
            { maxChars: TRUNCATION_DEFAULTS.subject }
          ),
          decoded_content: wrapUntrustedField(
            "decoded_content",
            decodedContent,
            { maxChars: TRUNCATION_DEFAULTS.body }
          ),
        }
      );
    },
    "Get file/directory contents",
    { sideEffect: "read" }
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
      const data = JSON.parse(result) as Array<{
        fullName?: string;
        description?: string;
        url?: string;
        stargazersCount?: number;
        updatedAt?: string;
        visibility?: string;
      }>;
      const results = data.map((repo, i) => ({
        url: repo.url,
        stargazersCount: repo.stargazersCount,
        updatedAt: repo.updatedAt,
        visibility: repo.visibility,
        fullName: wrapUntrustedField(
          `results[${i}].fullName`,
          repo.fullName ?? "",
          { maxChars: TRUNCATION_DEFAULTS.subject }
        ),
        description: wrapUntrustedField(
          `results[${i}].description`,
          repo.description ?? "",
          { maxChars: TRUNCATION_DEFAULTS.body }
        ),
      }));
      return buildSafeOutput(
        {
          command: "search-repos",
          query: args.query,
          count: results.length,
        },
        { results }
      );
    },
    "Search repositories",
    { sideEffect: "read" }
  ),

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
      const data = JSON.parse(runGh(cmdArgs)) as Array<{
        number?: number;
        title?: string;
        state?: string;
        author?: { login?: string } | string;
        labels?: Array<{ name?: string } | string>;
        createdAt?: string;
        updatedAt?: string;
        url?: string;
      }>;
      const results = data.map((issue, i) => {
        const authorLogin =
          typeof issue.author === "object" && issue.author != null
            ? (issue.author.login ?? "")
            : String(issue.author ?? "");
        const labelNames = Array.isArray(issue.labels)
          ? issue.labels.map((l) =>
              typeof l === "object" && l != null ? (l.name ?? "") : String(l ?? "")
            )
          : [];
        return {
          number: issue.number,
          state: issue.state,
          createdAt: issue.createdAt,
          updatedAt: issue.updatedAt,
          url: issue.url,
          title: wrapUntrustedField(
            `results[${i}].title`,
            issue.title ?? "",
            { maxChars: TRUNCATION_DEFAULTS.subject }
          ),
          author: {
            login: wrapUntrustedField(
              `results[${i}].author.login`,
              authorLogin,
              { maxChars: TRUNCATION_DEFAULTS.displayName }
            ),
          },
          labels: labelNames.map((name, j) =>
            wrapUntrustedField(
              `results[${i}].labels[${j}]`,
              name,
              { maxChars: TRUNCATION_DEFAULTS.displayName }
            )
          ),
        };
      });
      return buildSafeOutput(
        {
          command: "list-issues",
          repo: args.repo,
          state: args.state,
          count: results.length,
        },
        { results }
      );
    },
    "List issues",
    { sideEffect: "read" }
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
      const issue = JSON.parse(result);
      return wrapIssueOrPrDetail(issue, args.repo as string, "get-issue");
    },
    "Get issue details",
    { sideEffect: "read" }
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
    "Create an issue",
    { sideEffect: "write" }
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

      const result = runGh([
        "issue", "view", String(number),
        "--repo", repo,
        "--json", "number,title,state,body,author,labels,assignees,milestone,createdAt,updatedAt,url,comments"
      ]);
      const issue = JSON.parse(result);
      return wrapIssueOrPrDetail(issue, repo, "update-issue");
    },
    "Update an issue",
    { sideEffect: "write" }
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
    "Add comment to issue/PR",
    { sideEffect: "write" }
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
      const data = JSON.parse(result) as Array<{
        number?: number;
        title?: string;
        state?: string;
        repository?: { name?: string; nameWithOwner?: string } | string;
        author?: unknown;
        createdAt?: string;
        url?: string;
      }>;
      const results = data.map((issue, i) => {
        const repoFullName =
          typeof issue.repository === "object" && issue.repository != null
            ? (issue.repository.nameWithOwner ?? issue.repository.name ?? "")
            : String(issue.repository ?? "");
        return {
          number: issue.number,
          state: issue.state,
          createdAt: issue.createdAt,
          url: issue.url,
          title: wrapUntrustedField(
            `results[${i}].title`,
            issue.title ?? "",
            { maxChars: TRUNCATION_DEFAULTS.subject }
          ),
          author: {
            login: wrapUntrustedField(
              `results[${i}].author.login`,
              extractLogin(issue.author),
              { maxChars: TRUNCATION_DEFAULTS.displayName }
            ),
          },
          repository: {
            full_name: wrapUntrustedField(
              `results[${i}].repository.full_name`,
              repoFullName,
              { maxChars: TRUNCATION_DEFAULTS.subject }
            ),
          },
        };
      });
      return buildSafeOutput(
        {
          command: "search-issues",
          query: args.query,
          count: results.length,
        },
        { results }
      );
    },
    "Search issues",
    { sideEffect: "read" }
  ),

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
      const data = JSON.parse(runGh(cmdArgs)) as Array<any>;
      const results = data.map((pr, i) => ({
        number: pr.number,
        state: pr.state,
        isDraft: pr.isDraft,
        createdAt: pr.createdAt,
        updatedAt: pr.updatedAt,
        url: pr.url,
        title: wrapUntrustedField(
          `results[${i}].title`,
          pr.title ?? "",
          { maxChars: TRUNCATION_DEFAULTS.subject }
        ),
        author: {
          login: wrapUntrustedField(
            `results[${i}].author.login`,
            extractLogin(pr.author),
            { maxChars: TRUNCATION_DEFAULTS.displayName }
          ),
        },
        headRefName: wrapUntrustedField(
          `results[${i}].headRefName`,
          pr.headRefName ?? "",
          { maxChars: TRUNCATION_DEFAULTS.displayName }
        ),
        baseRefName: wrapUntrustedField(
          `results[${i}].baseRefName`,
          pr.baseRefName ?? "",
          { maxChars: TRUNCATION_DEFAULTS.displayName }
        ),
      }));
      return buildSafeOutput(
        {
          command: "list-prs",
          repo: args.repo,
          state: args.state,
          count: results.length,
        },
        { results }
      );
    },
    "List pull requests",
    { sideEffect: "read" }
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
      const pr = JSON.parse(result);
      return wrapIssueOrPrDetail(pr, args.repo as string, "get-pr");
    },
    "Get PR details",
    { sideEffect: "read" }
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
    "Create a pull request",
    { sideEffect: "write" }
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
    "Merge a pull request",
    { sideEffect: "external_send", requiresConfirmation: true }
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
    "Create a PR review",
    { sideEffect: "write" }
  ),

  "get-pr-files": createCommand(
    z.object({
      repo: z.string().min(1).describe("Repository (owner/name)"),
      number: cliTypes.int(1).describe("PR number"),
    }),
    async (args) => {
      const { owner, repo } = parseRepoArg(args.repo as string);
      const result = runGh([
        "api",
        "--paginate",
        `repos/${owner}/${repo}/pulls/${args.number}/files`,
        "-F",
        "per_page=100",
        "--jq",
        ".[]",
      ]);
      const data = result.trim()
        ? result.split(/\n+/).filter(Boolean).map((line) => parseJson<{
          filename?: string;
          previous_filename?: string;
          sha?: string;
          status?: string;
          additions?: number;
          deletions?: number;
          changes?: number;
          patch?: string;
        }>(line, "gh api pull files page"))
        : [] as Array<{
        filename?: string;
        previous_filename?: string;
        sha?: string;
        status?: string;
        additions?: number;
        deletions?: number;
        changes?: number;
        patch?: string;
      }>;
      const files = data.map((file, i) => {
        const wrapped: Record<string, unknown> = {
          sha: file.sha,
          status: file.status,
          additions: file.additions,
          deletions: file.deletions,
          changes: file.changes,
          filename: wrapUntrustedField(
            `files[${i}].filename`,
            file.filename ?? "",
            { maxChars: TRUNCATION_DEFAULTS.subject }
          ),
        };
        if (file.previous_filename !== undefined) {
          wrapped.previous_filename = wrapUntrustedField(
            `files[${i}].previous_filename`,
            file.previous_filename ?? "",
            { maxChars: TRUNCATION_DEFAULTS.subject }
          );
        }
        if (file.patch !== undefined) {
          wrapped.patch = wrapUntrustedField(
            `files[${i}].patch`,
            file.patch ?? "",
            { maxChars: TRUNCATION_DEFAULTS.body }
          );
        }
        return wrapped;
      });
      return buildSafeOutput(
        {
          command: "get-pr-files",
          repo: args.repo,
          pr_number: args.number,
          count: files.length,
        },
        { files }
      );
    },
    "Get PR changed files",
    { sideEffect: "read" }
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
      const data = JSON.parse(result) as {
        number?: number;
        state?: string;
        mergeable?: string;
        mergeStateStatus?: string;
        statusCheckRollup?: Array<any>;
        reviews?: Array<any>;
      };
      const reviews = Array.isArray(data.reviews)
        ? data.reviews.map((r: any, i: number) => ({
            id: r.id,
            state: r.state,
            submittedAt: r.submittedAt,
            author_login: wrapUntrustedField(
              `reviews[${i}].author_login`,
              extractLogin(r.author),
              { maxChars: TRUNCATION_DEFAULTS.displayName }
            ),
            body: wrapUntrustedField(
              `reviews[${i}].body`,
              r.body ?? "",
              { maxChars: TRUNCATION_DEFAULTS.body }
            ),
          }))
        : [];
      return buildSafeOutput(
        {
          command: "get-pr-status",
          repo: args.repo,
          number: data.number,
          state: data.state,
          mergeable: data.mergeable,
          mergeStateStatus: data.mergeStateStatus,
          statusCheckRollup: data.statusCheckRollup,
        },
        { reviews }
      );
    },
    "Get PR status and checks",
    { sideEffect: "read" }
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
    "Update PR branch from base",
    { sideEffect: "write" }
  ),

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
    "Create a new branch",
    { sideEffect: "write" }
  ),

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
    "Push files to a branch",
    { sideEffect: "external_send", requiresConfirmation: true }
  ),

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
      const data = JSON.parse(result) as Array<{
        path?: string;
        repository?: { name?: string; nameWithOwner?: string } | string;
        textMatches?: Array<{ fragment?: string; property?: string }>;
      }>;
      const results = data.map((match, i) => {
        const repoFullName =
          typeof match.repository === "object" && match.repository != null
            ? (match.repository.nameWithOwner ?? match.repository.name ?? "")
            : String(match.repository ?? "");
        const textMatches = Array.isArray(match.textMatches)
          ? match.textMatches.map((tm, j) => ({
              property: tm.property,
              fragment: wrapUntrustedField(
                `results[${i}].text_matches[${j}].fragment`,
                tm.fragment ?? "",
                { maxChars: TRUNCATION_DEFAULTS.snippet }
              ),
            }))
          : [];
        return {
          path: wrapUntrustedField(
            `results[${i}].path`,
            match.path ?? "",
            { maxChars: TRUNCATION_DEFAULTS.subject }
          ),
          repository: {
            full_name: wrapUntrustedField(
              `results[${i}].repository.full_name`,
              repoFullName,
              { maxChars: TRUNCATION_DEFAULTS.subject }
            ),
          },
          text_matches: textMatches,
        };
      });
      return buildSafeOutput(
        {
          command: "search-code",
          query: args.query,
          count: results.length,
        },
        { results }
      );
    },
    "Search code",
    { sideEffect: "read" }
  ),

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

      const commits = history.nodes.map((node: CommitNode, i: number) => ({
        sha: node.oid,
        shortSha: node.oid.substring(0, 7),
        date: node.author.date,
        additions: node.additions,
        deletions: node.deletions,
        changedFiles: node.changedFilesIfAvailable,
        message: wrapUntrustedField(
          `commits[${i}].message`,
          node.message.split("\n")[0],
          { maxChars: TRUNCATION_DEFAULTS.subject }
        ),
        author: {
          name: wrapUntrustedField(
            `commits[${i}].author.name`,
            node.author.name,
            { maxChars: TRUNCATION_DEFAULTS.displayName }
          ),
        },
      }));

      return buildSafeOutput(
        {
          command: "list-commits",
          repo: args.repo,
          branch: branch ?? "(default)",
          count: commits.length,
        },
        { commits }
      );
    },
    "List commits",
    { sideEffect: "read" }
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

      return buildSafeOutput(
        {
          command: "get-commit",
          repo: args.repo,
          sha: commit.oid,
          shortSha: commit.oid.substring(0, 7),
          date: commit.author.date,
          additions: commit.additions,
          deletions: commit.deletions,
          changedFiles: commit.changedFilesIfAvailable,
          parents: commit.parents.nodes.map((p) => p.oid),
        },
        {
          message: wrapUntrustedField(
            "message",
            commit.message ?? "",
            { maxChars: TRUNCATION_DEFAULTS.body }
          ),
          author: {
            name: wrapUntrustedField(
              "author.name",
              commit.author.name,
              { maxChars: TRUNCATION_DEFAULTS.displayName }
            ),
          },
        }
      );
    },
    "Get commit details",
    { sideEffect: "read" }
  ),
};

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runCli(commands, GitHubCLI, {
    programName: "github-cli",
    description: "GitHub operations via gh CLI",
  });
}

