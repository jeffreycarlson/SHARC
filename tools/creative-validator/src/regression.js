/**
 * @file Private corpus regression comparison helpers.
 */

function stableValue(value) {
  return value == null ? null : String(value);
}

function reportKey(row) {
  const testCase = row && row.case ? row.case : {};
  const source = testCase.source || {};
  const ids = testCase.ids || {};
  return JSON.stringify({
    sourceFile: stableValue(source.sourceFile),
    rowIndex: source.rowIndex ?? null,
    bidder: stableValue(source.bidder),
    mtype: stableValue(source.mtype),
    bidId: stableValue(ids.bidId),
    crid: stableValue(ids.crid),
  });
}

function publicReportIdentity(row) {
  const testCase = row && row.case ? row.case : {};
  const source = testCase.source || {};
  const ids = testCase.ids || {};
  return {
    bidId: ids.bidId ?? null,
    crid: ids.crid ?? null,
    bidder: source.bidder ?? null,
    mtype: source.mtype ?? null,
    rowIndex: source.rowIndex ?? null,
    sourceFile: source.sourceFile ?? null,
  };
}

function verdict(row) {
  const outcome = row && row.outcome ? row.outcome : {};
  return {
    status: outcome.status ?? 'unknown',
    bucket: outcome.bucket ?? 'unknown',
    reason: outcome.reason ?? null,
  };
}

function verdictId(item) {
  return `${item.status}/${item.bucket}`;
}

function noteKeyFor(row) {
  const testCase = row && row.case ? row.case : {};
  const source = testCase.source || {};
  const ids = testCase.ids || {};
  const candidates = [
    ids.bidId,
    ids.crid,
    `${source.sourceFile ?? ''}:${source.rowIndex ?? ''}`,
    reportKey(row),
  ];
  return candidates.find((candidate) => typeof candidate === 'string' && candidate.length > 0) || null;
}

function normalizeNotes(notes = {}) {
  if (!notes || typeof notes !== 'object' || Array.isArray(notes)) return {};
  if (Array.isArray(notes.verdictChanges)) {
    return Object.fromEntries(notes.verdictChanges.map((note) => [note.key, note]));
  }
  return notes;
}

function lookupNote(notes, baselineRow, currentRow) {
  const normalized = normalizeNotes(notes);
  for (const row of [currentRow, baselineRow]) {
    const key = noteKeyFor(row);
    if (key && normalized[key]) return normalized[key];
    const stableKey = reportKey(row);
    if (normalized[stableKey]) return normalized[stableKey];
  }
  return null;
}

function indexReports(rows, label) {
  const byKey = new Map();
  const duplicateKeys = [];
  for (const row of rows) {
    const key = reportKey(row);
    if (byKey.has(key)) {
      duplicateKeys.push({ key, label, identity: publicReportIdentity(row) });
      continue;
    }
    byKey.set(key, row);
  }
  return { byKey, duplicateKeys };
}

function countByVerdict(rows) {
  const counts = {};
  for (const row of rows) {
    const id = verdictId(verdict(row));
    counts[id] = (counts[id] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

function describeChange(baselineRow, currentRow, notes) {
  const before = verdict(baselineRow);
  const after = verdict(currentRow);
  const note = lookupNote(notes, baselineRow, currentRow);
  const passToFail = before.status === 'passed' && after.status === 'failed';
  const rowKey = reportKey(currentRow);
  return {
    key: noteKeyFor(currentRow) || noteKeyFor(baselineRow) || rowKey,
    rowKey,
    identity: publicReportIdentity(currentRow),
    before,
    after,
    passToFail,
    attribution: note && note.attribution ? note.attribution : (passToFail ? 'needs-triage' : 'diagnostic'),
    cause: note && note.cause ? note.cause : null,
  };
}

/**
 * Compares two private corpus report row sets.
 *
 * @param {object[]} baselineRows
 * @param {object[]} currentRows
 * @param {{baselineLabel?: string, currentLabel?: string, notes?: object}} [options]
 * @returns {object}
 */
export function compareReportVerdicts(baselineRows, currentRows, options = {}) {
  const baseline = indexReports(baselineRows, 'baseline');
  const current = indexReports(currentRows, 'current');
  const keys = new Set([...baseline.byKey.keys(), ...current.byKey.keys()]);
  const verdictChanges = [];
  const missingInCurrent = [];
  const addedInCurrent = [];

  for (const key of [...keys].sort()) {
    const baselineRow = baseline.byKey.get(key);
    const currentRow = current.byKey.get(key);
    if (!baselineRow) {
      addedInCurrent.push({
        key,
        rowKey: key,
        identity: publicReportIdentity(currentRow),
        verdict: verdict(currentRow),
      });
      continue;
    }
    if (!currentRow) {
      missingInCurrent.push({
        key,
        rowKey: key,
        identity: publicReportIdentity(baselineRow),
        verdict: verdict(baselineRow),
      });
      continue;
    }
    const before = verdict(baselineRow);
    const after = verdict(currentRow);
    if (verdictId(before) !== verdictId(after) || before.reason !== after.reason) {
      verdictChanges.push(describeChange(baselineRow, currentRow, options.notes));
    }
  }

  const passToFail = verdictChanges.filter((change) => change.passToFail);
  const sharcRegressions = passToFail.filter((change) => change.attribution === 'sharc');
  const undocumentedPassToFail = passToFail.filter((change) => change.attribution === 'needs-triage');
  const undocumentedVerdictChanges = verdictChanges.filter((change) => !change.cause);

  return {
    generatedAt: new Date().toISOString(),
    baseline: {
      label: options.baselineLabel || 'baseline',
      rows: baselineRows.length,
      byVerdict: countByVerdict(baselineRows),
    },
    current: {
      label: options.currentLabel || 'current',
      rows: currentRows.length,
      byVerdict: countByVerdict(currentRows),
    },
    totals: {
      comparedRows: keys.size,
      verdictChanges: verdictChanges.length,
      passToFail: passToFail.length,
      sharcPassToFailRegressions: sharcRegressions.length,
      undocumentedPassToFail: undocumentedPassToFail.length,
      undocumentedVerdictChanges: undocumentedVerdictChanges.length,
      missingInCurrent: missingInCurrent.length,
      addedInCurrent: addedInCurrent.length,
      duplicateKeys: baseline.duplicateKeys.length + current.duplicateKeys.length,
    },
    regressionClean: sharcRegressions.length === 0 && undocumentedPassToFail.length === 0,
    verdictChanges,
    passToFail,
    sharcRegressions,
    undocumentedPassToFail,
    missingInCurrent,
    addedInCurrent,
    duplicateKeys: [...baseline.duplicateKeys, ...current.duplicateKeys],
  };
}
