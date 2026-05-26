/**
 * @file Creative validator report triage.
 *
 * Converts private runner report JSONL into aggregate summaries for manual
 * issue filing and synthetic-reduction planning. The summary intentionally
 * avoids raw creative markup and keeps sample identifiers bounded.
 */

import { readFileSync } from 'fs';
import { basename } from 'path';

const SAMPLE_LIMIT = 5;

function emptySummary(files) {
  return {
    generatedAt: new Date().toISOString(),
    sourceFiles: files.map((file) => basename(file)),
    totals: {
      reports: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      other: 0,
    },
    byStatus: {},
    byBucket: {},
    byBidder: {},
    byMtype: {},
    byAdmKind: {},
    byApi: {},
    byExpectedBridge: {},
    failureGroups: [],
    reductionCandidates: [],
  };
}

function increment(map, key, amount = 1) {
  const normalized = normalizeKey(key);
  map[normalized] = (map[normalized] || 0) + amount;
}

function normalizeKey(value) {
  if (value === null || value === undefined || value === '') return 'unknown';
  return String(value);
}

function apiKey(row) {
  const values = row
    && row.case
    && row.case.bidSignals
    && row.case.bidSignals.apis
    && row.case.bidSignals.apis.sanitized;
  return Array.isArray(values) && values.length > 0 ? values.join(',') : 'none';
}

function expectedBridgeKeys(row) {
  const declared = (row.case && row.case.expectations && row.case.expectations.declared) || [];
  const sniffed = (row.case && row.case.expectations && row.case.expectations.sniffed) || [];
  const set = new Set([...declared, ...sniffed]);
  return set.size > 0 ? [...set].sort() : ['none'];
}

function reportFields(row) {
  const source = (row.case && row.case.source) || {};
  const creative = (row.case && row.case.creative) || {};
  const bidSignals = (row.case && row.case.bidSignals) || {};
  const outcome = row.outcome || {};
  return {
    status: normalizeKey(outcome.status),
    bucket: normalizeKey(outcome.bucket),
    bidder: normalizeKey(source.bidder),
    mtype: normalizeKey(bidSignals.mtype || source.mtype),
    admKind: normalizeKey(creative.admKind),
    api: apiKey(row),
  };
}

function sampleId(row) {
  const ids = (row.case && row.case.ids) || {};
  const source = (row.case && row.case.source) || {};
  const sourceFile = normalizeKey(source.sourceFile);
  return {
    bidId: normalizeKey(ids.bidId),
    crid: normalizeKey(ids.crid),
    sourceFile: sourceFile === 'unknown' ? 'unknown' : basename(sourceFile),
    rowIndex: source.rowIndex === undefined ? null : source.rowIndex,
  };
}

function addFailureGroup(groups, row) {
  const fields = reportFields(row);
  const key = [
    fields.bucket,
    fields.bidder,
    fields.mtype,
    fields.admKind,
    fields.api,
  ].join('\u001f');
  let group = groups.get(key);
  if (!group) {
    group = {
      bucket: fields.bucket,
      bidder: fields.bidder,
      mtype: fields.mtype,
      admKind: fields.admKind,
      api: fields.api,
      count: 0,
      samples: [],
    };
    groups.set(key, group);
  }
  group.count += 1;
  if (group.samples.length < SAMPLE_LIMIT) {
    group.samples.push(sampleId(row));
  }
}

function sortEntries(map) {
  return Object.fromEntries(Object.entries(map)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

function sortedGroups(groups) {
  return [...groups.values()].sort((a, b) =>
    b.count - a.count
    || a.bucket.localeCompare(b.bucket)
    || a.bidder.localeCompare(b.bidder)
    || a.mtype.localeCompare(b.mtype)
    || a.admKind.localeCompare(b.admKind)
    || a.api.localeCompare(b.api));
}

function isReductionCandidate(group) {
  return group.bucket !== 'passed'
    && group.bucket !== 'unsupported-input'
    && group.count > 0;
}

function readReportJsonl(file) {
  const text = readFileSync(file, 'utf8').trim();
  if (!text) return [];
  return text.split('\n').map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (err) {
      throw new Error(`Failed to parse ${basename(file)} line ${index + 1}: ${err.message}`);
    }
  });
}

function triageReports(files) {
  const summary = emptySummary(files);
  const failureGroups = new Map();

  for (const file of files) {
    for (const row of readReportJsonl(file)) {
      const fields = reportFields(row);
      summary.totals.reports += 1;
      increment(summary.byStatus, fields.status);
      increment(summary.byBucket, fields.bucket);
      increment(summary.byBidder, fields.bidder);
      increment(summary.byMtype, fields.mtype);
      increment(summary.byAdmKind, fields.admKind);
      increment(summary.byApi, fields.api);
      for (const bridge of expectedBridgeKeys(row)) {
        increment(summary.byExpectedBridge, bridge);
      }

      if (fields.status === 'passed') summary.totals.passed += 1;
      else if (fields.status === 'skipped') summary.totals.skipped += 1;
      else if (fields.status === 'failed') {
        summary.totals.failed += 1;
        addFailureGroup(failureGroups, row);
      } else {
        summary.totals.other += 1;
      }
    }
  }

  summary.byStatus = sortEntries(summary.byStatus);
  summary.byBucket = sortEntries(summary.byBucket);
  summary.byBidder = sortEntries(summary.byBidder);
  summary.byMtype = sortEntries(summary.byMtype);
  summary.byAdmKind = sortEntries(summary.byAdmKind);
  summary.byApi = sortEntries(summary.byApi);
  summary.byExpectedBridge = sortEntries(summary.byExpectedBridge);
  summary.failureGroups = sortedGroups(failureGroups);
  summary.reductionCandidates = summary.failureGroups
    .filter(isReductionCandidate)
    .slice(0, 20);
  return summary;
}

export {
  triageReports,
};
