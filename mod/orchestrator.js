// Pure poll rules: which issues are ready, their order, worktree paths and the first message.
// No Herdr imports, so `node --test` can load this file.
import { identifierOf, milestoneNumber } from "./linear.js";

export const issueTabs = (space) => (space?.tabs ?? [])
  .map((tab) => ({ tab, ident: identifierOf(tab) }))
  .filter((t) => t.ident);

const milestoneRank = (issue) => (!issue.milestone ? 2 : milestoneNumber(issue.milestone.name) == null ? 1 : 0);
// Linear's priority 0 is "no priority"; it goes after Low (4).
const priorityRank = (issue) => issue.priority || 5;

// Numbered milestones by number, then unnumbered ones in Linear's order, then no milestone; then
// priority; then Linear's own issue order.
export function compareForPickup(a, b) {
  const rank = milestoneRank(a) - milestoneRank(b);
  if (rank) return rank;
  if (milestoneRank(a) === 0) {
    const byNumber = milestoneNumber(a.milestone.name) - milestoneNumber(b.milestone.name);
    if (byNumber) return byNumber;
  }
  return (a.milestone?.sortOrder ?? 0) - (b.milestone?.sortOrder ?? 0)
    || priorityRank(a) - priorityRank(b)
    || a.sortOrder - b.sortOrder;
}

// `assigneeId` null asks for the unassigned issues.
export function readyIssues(issues, { assigneeId, tabIdents }) {
  return issues
    .filter((i) => i.stateType === "unstarted" && i.assigneeId === assigneeId
      && !tabIdents.has(i.identifier) && !i.blockedBy?.length)
    .sort(compareForPickup);
}

// Herdr's worktree convention: ~/.herdr/worktrees/<repo>/<branch with other characters changed to ->.
export const worktreeSlug = (branch) => branch.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");

// `git worktree list --porcelain`; the first entry is the main checkout.
export function parseWorktrees(porcelain) {
  return porcelain.split(/\n\n+/).map((block) => {
    const path = block.match(/^worktree (.+)$/m)?.[1];
    const branch = block.match(/^branch refs\/heads\/(.+)$/m)?.[1] ?? null;
    return path ? { path, branch } : null;
  }).filter(Boolean);
}

export function startTask(issue) {
  const comments = issue.comments ?? [];
  const lines = [
    `/start-issue ${issue.identifier}`,
    "",
    "The mod already made your worktree, and this terminal starts in it. The issue is below, so do not get it from Linear.",
    "",
    `# ${issue.identifier}: ${issue.title}`,
    `Branch: ${issue.branchName ?? "none"}`,
  ];
  if (issue.milestone) lines.push(`Milestone: ${issue.milestone.name}`);
  lines.push("", issue.description?.trim() || "No description.");
  if (comments.length) {
    lines.push("", "## Comments, newest first");
    for (const c of comments) lines.push("", `${c.author}, ${c.createdAt.slice(0, 10)}:`, c.body.trim());
  }
  if (issue.moreComments) lines.push("", `${issue.moreComments} older comments are in Linear. Read them only if you need them.`);
  return lines.join("\n");
}
