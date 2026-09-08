
import {
  wrapUntrustedField,
  buildSafeOutput,
  TRUNCATION_DEFAULTS,
  type SafeOutput,
} from "@local/cli-utils";

interface GhActor {
  login?: string;
  name?: string;
  id?: string;
  is_bot?: boolean;
}

export function extractLogin(actor: unknown): string {
  if (actor && typeof actor === "object") {
    const a = actor as GhActor;
    if (typeof a.login === "string") return a.login;
    if (typeof a.name === "string") return a.name;
  }
  return actor == null ? "" : String(actor);
}

export function extractLabelName(label: unknown): string {
  if (label && typeof label === "object") {
    const l = label as { name?: string };
    if (typeof l.name === "string") return l.name;
  }
  return label == null ? "" : String(label);
}

export function wrapIssueOrPrDetail(
  detail: any,
  repo: string,
  command: string
): SafeOutput {
  const authorLogin = extractLogin(detail.author);

  const labels = Array.isArray(detail.labels)
    ? detail.labels.map((l: unknown, i: number) =>
        wrapUntrustedField(
          `labels[${i}]`,
          extractLabelName(l),
          { maxChars: TRUNCATION_DEFAULTS.displayName }
        )
      )
    : [];

  const assignees = Array.isArray(detail.assignees)
    ? detail.assignees.map((a: unknown, i: number) =>
        wrapUntrustedField(
          `assignees[${i}].login`,
          extractLogin(a),
          { maxChars: TRUNCATION_DEFAULTS.displayName }
        )
      )
    : [];

  const comments = Array.isArray(detail.comments)
    ? detail.comments.map((c: any, i: number) => ({
        id: c.id,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
        author_login: wrapUntrustedField(
          `comments[${i}].author_login`,
          extractLogin(c.author),
          { maxChars: TRUNCATION_DEFAULTS.displayName }
        ),
        text: wrapUntrustedField(
          `comments[${i}].text`,
          c.body ?? "",
          { maxChars: TRUNCATION_DEFAULTS.body }
        ),
      }))
    : [];

  const reviews = Array.isArray(detail.reviews)
    ? detail.reviews.map((r: any, i: number) => ({
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

  const reviewRequests = Array.isArray(detail.reviewRequests)
    ? detail.reviewRequests.map((rr: unknown, i: number) =>
        wrapUntrustedField(
          `reviewRequests[${i}].login`,
          extractLogin(rr),
          { maxChars: TRUNCATION_DEFAULTS.displayName }
        )
      )
    : [];

  const content: Record<string, unknown> = {
    title: wrapUntrustedField(
      "title",
      detail.title ?? "",
      { maxChars: TRUNCATION_DEFAULTS.subject }
    ),
    body: wrapUntrustedField(
      "body",
      detail.body ?? "",
      { maxChars: TRUNCATION_DEFAULTS.body }
    ),
    author: {
      login: wrapUntrustedField(
        "author.login",
        authorLogin,
        { maxChars: TRUNCATION_DEFAULTS.displayName }
      ),
    },
    labels,
    assignees,
    comments,
  };

  if (detail.headRefName !== undefined) {
    content.headRefName = wrapUntrustedField(
      "headRefName",
      detail.headRefName ?? "",
      { maxChars: TRUNCATION_DEFAULTS.displayName }
    );
  }
  if (detail.baseRefName !== undefined) {
    content.baseRefName = wrapUntrustedField(
      "baseRefName",
      detail.baseRefName ?? "",
      { maxChars: TRUNCATION_DEFAULTS.displayName }
    );
  }
  if (detail.reviewRequests !== undefined) {
    content.reviewRequests = reviewRequests;
  }
  if (detail.reviews !== undefined) {
    content.reviews = reviews;
  }

  const metadata: Record<string, unknown> = {
    command,
    repo,
    number: detail.number,
    state: detail.state,
    url: detail.url,
    createdAt: detail.createdAt,
    updatedAt: detail.updatedAt,
  };

  if (detail.isDraft !== undefined) metadata.isDraft = detail.isDraft;
  if (detail.mergeable !== undefined) metadata.mergeable = detail.mergeable;
  if (detail.additions !== undefined) metadata.additions = detail.additions;
  if (detail.deletions !== undefined) metadata.deletions = detail.deletions;
  if (detail.changedFiles !== undefined) metadata.changedFiles = detail.changedFiles;

  if (detail.milestone !== undefined && detail.milestone !== null) {
    const milestoneTitle =
      typeof detail.milestone === "object"
        ? (detail.milestone.title ?? "")
        : "";
    if (milestoneTitle) {
      content.milestone_title = wrapUntrustedField(
        "milestone_title",
        milestoneTitle,
        { maxChars: TRUNCATION_DEFAULTS.subject }
      );
    }
    metadata.milestone_number = detail.milestone?.number;
  }

  return buildSafeOutput(metadata, content);
}
