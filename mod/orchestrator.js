// Pure poll rules: which issues are ready, their order, and worktree paths.
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

// Your issues first, then unassigned ones, then other people's (only when the filter allows them).
const assigneeRank = (issue, viewerId) => (issue.assigneeId != null && issue.assigneeId === viewerId ? 0 : issue.assigneeId == null ? 1 : 2);

// The order in which a poll starts issues: by assignee, then compareForPickup.
export const pickupOrder = (viewerId) => (a, b) => assigneeRank(a, viewerId) - assigneeRank(b, viewerId) || compareForPickup(a, b);

// The queue's filter decides which issues a poll may start; its default conditions keep to Todo issues
// that are unassigned or yours and not blocked. A poll starts those that have no space yet.
export function readyIssues(issues, { tabIdents, viewerId = null }) {
  return issues
    .filter((i) => !tabIdents.has(i.identifier))
    .sort(pickupOrder(viewerId));
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

const isInside = (folder, path) => folder === path || folder.startsWith(`${path}/`);

// Linked worktrees under `root`, on a branch, that no open folder is in.
export function sweepCandidates(porcelain, { root, openFolders }) {
  return parseWorktrees(porcelain).slice(1)
    .filter((w) => w.branch && w.path.startsWith(`${root}/`) && !openFolders.some((f) => isInside(f, w.path)));
}

// The avatar colors that the stock spaces sidebar draws (its MARK names). ansi6 is its default for a
// space with no color, so it goes last.
export const SPACE_COLORS = ["ansi3", "ansi4", "ansi5", "ansi2", "ansi1", "ansi6"];

// A project keeps its color. A new one gets the color that the fewest active projects have, the
// earlier color on a tie. `assigned` is { "<project id>": "<color>" }; `active` is a Set of project IDs.
export function colorFor(projectId, assigned, active) {
  if (assigned[projectId]) return assigned[projectId];
  const uses = (color) => Object.entries(assigned).filter(([id, c]) => c === color && active.has(id)).length;
  return SPACE_COLORS.reduce((best, color) => (uses(color) < uses(best) ? color : best));
}

// The repo that an issue space's folder belongs to: a worktree under .herdr/worktrees/<repo>/…, or a
// checkout named after the repo, as on a cloud instance. Null for no folder.
export function repoOfFolder(folder) {
  if (!folder) return null;
  const parts = folder.replace(/\/+$/, "").split("/"), i = parts.indexOf("worktrees");
  return i > 0 && parts[i - 1] === ".herdr" && parts[i + 1] ? parts[i + 1] : parts.at(-1) || null;
}
