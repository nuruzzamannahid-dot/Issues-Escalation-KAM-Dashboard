/**
 * sync-sheet-status.js
 *
 * Polls the Issue Tracker's backend and the AD TEAM Google Sheet, and
 * auto-updates ticket status:
 *   Open        -> In Progress   (once a matching Consignment ID is found in the sheet)
 *   In Progress -> Resolved      (once OPS marks that row resolved in the sheet)
 *
 * Also sends a Telegram alert (same bot/recipients as the escalation form)
 * the first time OPS Remarks appear for a ticket — i.e. exactly when it
 * flips Open -> In Progress.
 *
 * Matches the real API used by merchants-issues-dashboard.onrender.com:
 *   GET   /api/issues                -> [{ id, consignmentId, merchant, inProcess, solved, ... }]
 *   PATCH /api/issues/:id/status     -> body { status: 'Open'|'In Progress'|'Resolved', respondedBy }
 *
 * Run on a schedule — e.g. a GitHub Actions workflow every 10-15 min,
 * same pattern as your reminder-bot.js.
 *
 * Env vars:
 *   SHEET_SEARCH_URL     required — Apps Script web app URL from sheet-search.gs (ends in /exec)
 *   TELEGRAM_BOT_TOKEN    optional — defaults to the same bot the escalation form uses
 *   TELEGRAM_CHAT_IDS     optional — comma-separated chat IDs, defaults to Nahid + Ahmed
 */

const API_BASE_URL = 'https://merchant-issues-escalation-databash.onrender.com';
const SHEET_SEARCH_URL = process.env.SHEET_SEARCH_URL;
const FALLBACK_RESPONDER_NAME = 'CarryBee Ops'; // used only if the sheet row has no KAM Name filled in

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8669705066:AAHuKUG2-a1DkZ-1tK60aIqp51q_o1K81Oo';
const TELEGRAM_CHAT_IDS = (process.env.TELEGRAM_CHAT_IDS || '8485545697,8839924588')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);

async function sendTelegramMessage(chatId, text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
  });
  return res.json();
}

async function notifyOpsRemarks(consignmentId, opsStatus) {
  const text = `📋 *${consignmentId}* is CID\nOPS REMARKS: ${opsStatus || '(no remarks text)'}`;
  await Promise.all(
    TELEGRAM_CHAT_IDS.map((chatId) =>
      sendTelegramMessage(chatId, text).catch((err) =>
        console.error(`Telegram send failed for ${chatId}:`, err)
      )
    )
  );
}

async function fetchIssues() {
  const res = await fetch(`${API_BASE_URL}/api/issues`);
  if (!res.ok) throw new Error(`GET /api/issues failed: ${res.status}`);
  return res.json();
}

async function patchStatus(issueId, status, respondedBy) {
  const res = await fetch(`${API_BASE_URL}/api/issues/${issueId}/status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status, respondedBy: respondedBy || FALLBACK_RESPONDER_NAME }),
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
      const match = result.matches[0];
      await patchStatus(issue.id, 'In Progress', match.kamName);
      console.log(`${issue.id} (${issue.consignmentId}): Open -> In Progress (${match.kamName || 'no KAM name in sheet'})`);
      if (match.opsStatus && match.opsStatus.trim().length > 0) {
        await notifyOpsRemarks(issue.consignmentId, match.opsStatus);
      } else {
        console.log(`${issue.id} (${issue.consignmentId}): no OPS remarks text yet — skipping Telegram alert`);
      }
      continue;
    }

    if (status === 'In Progress') {
      const resolvedMatch = result.matches.find((m) => m.resolved);
      if (resolvedMatch) {
        await patchStatus(issue.id, 'Resolved', resolvedMatch.kamName);
        console.log(`${issue.id} (${issue.consignmentId}): In Progress -> Resolved (${resolvedMatch.kamName || 'no KAM name in sheet'}, "${resolvedMatch.opsStatus}")`);
      }
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
