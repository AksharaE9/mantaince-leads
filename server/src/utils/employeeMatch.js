/**
 * Shared free-text "Employee Name" → user-id resolver, used by every bulk-
 * import / single-add path that has an employee/agent assignment concept
 * (Raw Data, Delivery Data, and COS/Positives' bulk upload). Extracted out
 * of rawDataImportSchema.js so the two independent import pipelines can't
 * drift on matching behavior, without merging their otherwise-deliberately-
 * separate schema/validator modules (see CLAUDE.md).
 *
 * Policy (phone-number-only-mandatory, see CLAUDE.md): an Employee Name
 * that's blank, unresolvable, or ambiguous NEVER blocks the row. It always
 * returns { userId, rawName, warning? } — callers insert the row with
 * userId (possibly null) and surface `warning` as a non-blocking warning,
 * never a validation error. The originally-typed text is always returned
 * as `rawName` so callers can persist it for audit even when unresolved.
 */

// ── Levenshtein distance — used only to find a confidently-close single
// match or to suggest closest matches for an unresolved name; never to
// silently guess between multiple similarly-close candidates. ──────────────
function levenshtein(a, b) {
    const m = a.length, n = b.length;
    const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            dp[i][j] = a[i - 1] === b[j - 1]
                ? dp[i - 1][j - 1]
                : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
        }
    }
    return dp[m][n];
}

// A distance this small is confidently "the same name, minor typo" (one
// transposed/missing/extra letter) — safe to auto-resolve. Anything looser
// is left unresolved with suggestions rather than guessed.
const AUTO_RESOLVE_DISTANCE = 2;

/**
 * Resolves a free-text employee name against the vertical's live agent
 * list. `agents` is [{id, name}], fetched once per batch by the caller.
 *
 * Returns { userId, rawName, warning? }:
 *  - Exact (case/whitespace-insensitive) single match → resolved, no warning.
 *  - Blank input → { userId: null, rawName: '' }, no warning (blank is a
 *    normal, non-mandatory field now — not a mismatch worth flagging).
 *  - Unique substring match, or a single confidently-close fuzzy match →
 *    resolved, with a "please verify" warning (this is the "loosened match"
 *    the phone-only-mandatory policy calls for, but still traceable).
 *  - Ambiguous (multiple equally-plausible candidates) or no match at all →
 *    unresolved (userId: null), with an explanatory warning + suggestions.
 */
export function resolveEmployeeName(name, agents) {
    const rawName = (name === undefined || name === null) ? '' : String(name).trim();
    const clean = rawName.toLowerCase();
    if (!clean) return { userId: null, rawName: '' };

    const list = Array.isArray(agents) ? agents : [];

    const exact = list.filter(a => a.name.trim().toLowerCase() === clean);
    if (exact.length === 1) return { userId: exact[0].id, rawName };
    if (exact.length > 1) {
        return {
            userId: null, rawName,
            warning: `Multiple employees named "${rawName}" exist — could not resolve unambiguously (${exact.map(a => a.name).join(', ')}); left unassigned`,
        };
    }

    const substring = list.filter(a => a.name.toLowerCase().includes(clean) || clean.includes(a.name.toLowerCase()));
    if (substring.length === 1) {
        return { userId: substring[0].id, rawName, warning: `"${rawName}" auto-matched to "${substring[0].name}" — please verify` };
    }
    if (substring.length > 1) {
        return {
            userId: null, rawName,
            warning: `"${rawName}" matches multiple employees (${substring.map(a => a.name).join(', ')}) — left unassigned, please verify`,
        };
    }

    if (list.length === 0) {
        return { userId: null, rawName, warning: `No employees are assignable in this vertical — "${rawName}" left unassigned` };
    }

    const ranked = list
        .map(a => ({ agent: a, distance: levenshtein(clean, a.name.toLowerCase()) }))
        .sort((x, y) => x.distance - y.distance);

    if (ranked[0].distance <= AUTO_RESOLVE_DISTANCE && (ranked.length === 1 || ranked[1].distance > AUTO_RESOLVE_DISTANCE)) {
        return { userId: ranked[0].agent.id, rawName, warning: `"${rawName}" auto-matched to "${ranked[0].agent.name}" (closest match) — please verify` };
    }

    const suggestions = ranked.slice(0, 3).filter(r => r.distance <= Math.max(3, Math.floor(clean.length / 2)));
    const warning = suggestions.length > 0
        ? `No confident match for employee "${rawName}" — closest matches: ${suggestions.map(r => r.agent.name).join(', ')} — left unassigned`
        : `No matching employee found for "${rawName}" — left unassigned`;
    return { userId: null, rawName, warning };
}

export default resolveEmployeeName;
