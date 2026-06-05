#!/usr/bin/env node
/**
 * Checks release-over-release size-history growth.
 *
 * The default threshold is >10% per minor/patch snapshot. That matches the
 * scale of headroom SHARC keeps meaningful in ADR-0001: routine movement should
 * pass, but sudden growth should require an explicit budget decision. A raised
 * limit in the newer snapshot must be proportional to that growth.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const historyDir = resolve(root, 'docs/size-history');
const threshold = Number(process.env.SHARC_SIZE_HISTORY_THRESHOLD || '0.10');
const shrinkThreshold = Number(process.env.SHARC_SIZE_HISTORY_SHRINK_THRESHOLD || '0.25');
const newModuleLimitRatio = Number(process.env.SHARC_SIZE_HISTORY_NEW_MODULE_LIMIT_RATIO || '0.90');

if (!Number.isFinite(threshold) || threshold < 0) {
  console.error('SHARC_SIZE_HISTORY_THRESHOLD must be a non-negative number.');
  process.exit(1);
}

if (!Number.isFinite(shrinkThreshold) || shrinkThreshold < 0) {
  console.error('SHARC_SIZE_HISTORY_SHRINK_THRESHOLD must be a non-negative number.');
  process.exit(1);
}

if (
  !Number.isFinite(newModuleLimitRatio)
  || newModuleLimitRatio < 0
  || newModuleLimitRatio > 1
) {
  console.error('SHARC_SIZE_HISTORY_NEW_MODULE_LIMIT_RATIO must be between 0 and 1.');
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
  if (!previousRow) {
    console.info(
      `INFO. New size-history module in ${currentFile}: ${name} `
      + `(${currentRow.size} B of ${currentRow.limit} B limit).`,
    );
    if (currentRow.limit > 0 && currentRow.size / currentRow.limit > newModuleLimitRatio) {
      failures.push({
        kind: 'new-module-near-limit',
        name,
        currentSize: currentRow.size,
        currentLimit: currentRow.limit,
        limitPercent: (currentRow.size / currentRow.limit) * 100,
      });
    }
    continue;
  }
  if (previousRow.size <= 0) continue;

  const growthBytes = currentRow.size - previousRow.size;
  const growthRatio = growthBytes / previousRow.size;
  const limitRaisedEnough = currentRow.limit > previousRow.limit
    && (currentRow.limit - previousRow.limit) / previousRow.limit > threshold;
  const shrinkRatio = -growthRatio;
  const limitLoweredEnough = currentRow.limit < previousRow.limit
    && (previousRow.limit - currentRow.limit) / previousRow.limit > shrinkThreshold;
  // Symmetric with shrinkage: 15% growth with only a 5% limit raise now fails
  // instead of treating the token raise as a real budget decision.
  if (growthRatio > threshold && !limitRaisedEnough) {
    failures.push({
      kind: 'growth',
      name,
      previousSize: previousRow.size,
      currentSize: currentRow.size,
      growthBytes,
      growthPercent: growthRatio * 100,
    });
  }
  if (shrinkRatio > shrinkThreshold && !limitLoweredEnough) {
    failures.push({
      kind: 'shrinkage',
      name,
      previousSize: previousRow.size,
      currentSize: currentRow.size,
      shrinkBytes: -growthBytes,
      shrinkPercent: -growthRatio * 100,
    });
  }
}

if (failures.length > 0) {
  console.error(
    `Size-history delta check failed for ${previousFile} -> ${currentFile}.`,
  );
  for (const failure of failures) {
    if (failure.kind === 'growth') {
      console.error(
        `  - ${failure.name}: ${failure.previousSize} B -> ${failure.currentSize} B `
        + `(+${failure.growthBytes} B, +${failure.growthPercent.toFixed(1)}%); `
        + 'growth exceeded threshold without a proportional limit raise.',
      );
    } else if (failure.kind === 'shrinkage') {
      console.error(
        `  - ${failure.name}: ${failure.previousSize} B -> ${failure.currentSize} B `
        + `(-${failure.shrinkBytes} B, -${failure.shrinkPercent.toFixed(1)}%); `
        + 'shrinkage exceeded threshold without a lowered limit.',
      );
    } else if (failure.kind === 'new-module-near-limit') {
      console.error(
        `  - ${failure.name}: new module starts at ${failure.currentSize} B `
        + `of ${failure.currentLimit} B limit (${failure.limitPercent.toFixed(1)}%).`,
      );
    }
  }
  process.exit(1);
}

console.log(
  `OK. Size-history deltas from ${previousFile} to ${currentFile} are within `
  + `${(threshold * 100).toFixed(1)}% growth / `
  + `${(shrinkThreshold * 100).toFixed(1)}% shrinkage thresholds, have matching `
  + 'limit decisions, or new modules are below the first-appearance budget guard.',
);
