/**
 * sync-sheet-status.js
 *
 * Polls the Issue Tracker's backend and the AD TEAM Google Sheet, and
 * auto-updates ticket status:
 *   Open        -> In Progress   (once a matching Consignment ID is found in the sheet)
 *   In Progress -> Resolved      (once OPS marks that row resolved in the sheet)
 *
 * Matches the real API used by merchants-issues-dashboard.onrender.com:
 *   GET   /api/issues                -> [{ id, consignmentId, merchant, inProcess, solved, ... }]
 *   PATCH /api/issues/:id/status     -> body { status: 'Open'|'In Progress'|'Resolved', respondedBy }
 *
 * Run on a schedule — e.g. a GitHub Actions workflow every 10-15 min,
 * same pattern as your reminder-bot.js.
 *
 * Env var required:
 *   SHEET_SEARCH_URL   the Apps Script web app URL from sheet-search.gs (ends in /exec)
 */

const API_BASE_URL = 'https://merchant-issues-escalation-databash.onrender.com';
const SHEET_SEARCH_URL = process.env.SHEET_SEARCH_URL;
const AUTO_RESPONDER_NAME = 'Auto-Sync (Sheet)';

async function fetchIssues() {
  const res = await fetch(`${API_BASE_URL}/api/issues`);
  if (!res.ok) throw new Error(`GET /api/issues failed: ${res.status}`);
  return res.json();
}

async function patchStatus(issueId, status) {
  const res = await fetch(`${API_BASE_URL}/api/issues/${issueId}/status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status, respondedBy: AUTO_RESPONDER_NAME }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `PATCH /api/issues/${issueId}/status failed: ${res.status}`);
  }
  return res.json();
}

async function searchSheet(consignmentId) {
  const url = `${SHEET_SEARCH_URL}?consignmentId=${encodeURIComponent(consignmentId)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Sheet search failed: ${res.status}`);
  return res.json();
}

function getStatus(issue) {
  if (issue.solved) return 'Resolved';
  if (issue.inProcess) return 'In Progress';
  return 'Open';
}

async function main() {
  if (!SHEET_SEARCH_URL) {
    throw new Error('SHEET_SEARCH_URL env var is required');
  }

  const issues = await fetchIssues();

  for (const issue of issues) {
    if (!issue.consignmentId) continue;

    const status = getStatus(issue);
    if (status === 'Resolved') continue; // nothing to do

    const result = await searchSheet(issue.consignmentId);
    if (!result.found) continue;

    if (status === 'Open') {
      await patchStatus(issue.id, 'In Progress');
      console.log(`${issue.id} (${issue.consignmentId}): Open -> In Progress`);
      continue;
    }

    if (status === 'In Progress') {
      const resolvedMatch = result.matches.find((m) => m.resolved);
      if (resolvedMatch) {
        await patchStatus(issue.id, 'Resolved');
        console.log(`${issue.id} (${issue.consignmentId}): In Progress -> Resolved (${resolvedMatch.tab}, "${resolvedMatch.opsStatus}")`);
      }
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
