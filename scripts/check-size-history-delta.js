#!/usr/bin/env node
/**
 * Checks release-over-release size-history growth.
 *
 * The default threshold is >10% per minor/patch snapshot. That matches the
 * scale of headroom SHARC keeps meaningful in ADR-0001: routine movement should
 * pass, but sudden growth should require an explicit budget decision. A raised
 * limit in the newer snapshot is treated as that decision.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const historyDir = resolve(root, 'docs/size-history');
const threshold = Number(process.env.SHARC_SIZE_HISTORY_THRESHOLD || '0.10');

if (!Number.isFinite(threshold) || threshold < 0) {
  console.error('SHARC_SIZE_HISTORY_THRESHOLD must be a non-negative number.');
  process.exit(1);
}

function parseVersion(filename) {
  const match = /^(\d+)\.(\d+)\.(\d+)\.json$/.exec(filename);
  if (!match) return null;
  return match.slice(1).map(Number);
}

function compareVersionFiles(a, b) {
  const av = parseVersion(a);
  const bv = parseVersion(b);
  for (let i = 0; i < av.length; i++) {
    if (av[i] !== bv[i]) return av[i] - bv[i];
  }
  return 0;
}

function loadSnapshot(filename) {
  const rows = JSON.parse(readFileSync(resolve(historyDir, filename), 'utf8'));
  const byName = new Map();
  for (const row of rows) {
    if (!row?.name || !Number.isFinite(row.size) || !Number.isFinite(row.limit)) {
      throw new Error(`${filename} has an invalid size-history row.`);
    }
    byName.set(row.name, row);
  }
  return byName;
}

const snapshots = readdirSync(historyDir)
  .filter((file) => parseVersion(file))
  .sort(compareVersionFiles);

if (snapshots.length < 2) {
  console.log('OK. Size-history delta check skipped: fewer than two snapshots.');
  process.exit(0);
}

const previousFile = snapshots[snapshots.length - 2];
const currentFile = snapshots[snapshots.length - 1];
const previous = loadSnapshot(previousFile);
const current = loadSnapshot(currentFile);
const failures = [];

for (const [name, currentRow] of current.entries()) {
  const previousRow = previous.get(name);
  if (!previousRow || previousRow.size <= 0) continue;

  const growthBytes = currentRow.size - previousRow.size;
  const growthRatio = growthBytes / previousRow.size;
  const limitRaised = currentRow.limit > previousRow.limit;
  if (growthRatio > threshold && !limitRaised) {
    failures.push({
      name,
      previousSize: previousRow.size,
      currentSize: currentRow.size,
      growthBytes,
      growthPercent: growthRatio * 100,
    });
  }
}

if (failures.length > 0) {
  console.error(
    `Size-history delta check failed: ${currentFile} grew more than `
    + `${(threshold * 100).toFixed(1)}% over ${previousFile} without a raised limit.`,
  );
  for (const failure of failures) {
    console.error(
      `  - ${failure.name}: ${failure.previousSize} B -> ${failure.currentSize} B `
      + `(+${failure.growthBytes} B, +${failure.growthPercent.toFixed(1)}%)`,
    );
  }
  process.exit(1);
}

console.log(
  `OK. Size-history deltas from ${previousFile} to ${currentFile} are within `
  + `${(threshold * 100).toFixed(1)}% or have raised limits.`,
);
