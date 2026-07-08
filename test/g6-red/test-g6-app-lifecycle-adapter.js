#!/usr/bin/env node

/**
 * G6 red contract R-B — the app lifecycle adapter exists and is selectable.
 *
 * Designed contract (G6 design doc, Decision 4.5): a new AppLifecycleAdapter
 * lands on the src/lifecycle-adapters/ seam (the seam the DoD says was "built
 * for this"). It extends HtmlAdapter — layering the host-asserted lifecycle
 * axis on top of the browser-native signals, exactly the "framework-specific
 * signals on top" subclass shape the adapter family header promised — and
 * applies the most-severe rule (active < passive < hidden < frozen).
 *
 * Selection is operator-declared: SHARCContainer gains the hostContext
 * option ('web' default | 'app', Rule-11-strict), and the
 * _selectLifecycleAdapter seam honors it as a second parameter. The embedder
 * knows it is inside a WebView; sniffing lies.
 *
 * RED today: src/lifecycle-adapters/app-adapter.js does not exist and
 * _selectLifecycleAdapter ignores everything but apiFramework.
 *
 * See ADR: ~/Obsidian/dev-team/sharc/2026-07-08-g6-omid-in-app-design.md
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { SHARCContainer } from '../../src/sharc-container.js';
import { HtmlAdapter } from '../../src/lifecycle-adapters/html-adapter.js';
import { BaseLifecycleAdapter } from '../../src/lifecycle-adapters/base-adapter.js';

const ADAPTER_PATH = '../../src/lifecycle-adapters/app-adapter.js';
const MODULE_MISSING =
  'G6 adapter contract: src/lifecycle-adapters/app-adapter.js must exist and '
  + 'export AppLifecycleAdapter (the DoD\'s "app lifecycle adapter" on the '
  + 'seam built for it) — the module does not exist today';

async function loadAdapterModule() {
  try {
    return await import(ADAPTER_PATH);
  } catch (_) {
    return null;
  }
}

test('G6 R-B: app-adapter module exists and exports AppLifecycleAdapter', async () => {
  const mod = await loadAdapterModule();
  assert.ok(mod && typeof mod.AppLifecycleAdapter === 'function', MODULE_MISSING);
});

test('G6 R-B: AppLifecycleAdapter layers on HtmlAdapter (adapter-family subclass shape)', async () => {
  const mod = await loadAdapterModule();
  assert.ok(mod && typeof mod.AppLifecycleAdapter === 'function', MODULE_MISSING);
  const adapter = new mod.AppLifecycleAdapter();
  assert.ok(
    adapter instanceof HtmlAdapter && adapter instanceof BaseLifecycleAdapter,
    'G6 adapter contract: AppLifecycleAdapter extends HtmlAdapter — it LAYERS '
      + 'the host lifecycle axis on the browser-native signals (the base '
      + 'family\'s promised subclass shape), it does not replace them',
  );
});

test('G6 R-B: _selectLifecycleAdapter honors hostContext and selects the app adapter', async () => {
  const mod = await loadAdapterModule();
  assert.ok(mod && typeof mod.AppLifecycleAdapter === 'function', MODULE_MISSING);
  const selected = SHARCContainer._selectLifecycleAdapter(null, 'app');
  assert.ok(
    selected instanceof mod.AppLifecycleAdapter,
    'G6 adapter contract: SHARCContainer._selectLifecycleAdapter(apiFramework, '
      + "hostContext) must return an AppLifecycleAdapter for hostContext 'app' "
      + '— the selection seam currently ignores the in-app context entirely '
      + '(got ' + (selected && selected.constructor && selected.constructor.name) + ')',
  );
});

// NOTE: GREEN today by construction (there is no app adapter to mis-select).
// Kept deliberately as the C3 invariant pin: stock web embeds stay
// byte-identical — the app adapter must never become a default.
test('G6 R-B: hostContext default stays web — selection without context returns HtmlAdapter, not the app adapter (baseline pin — green today)', async () => {
  const mod = await loadAdapterModule();
  const selected = SHARCContainer._selectLifecycleAdapter(null);
  assert.ok(
    selected instanceof HtmlAdapter
      && !(mod && typeof mod.AppLifecycleAdapter === 'function'
           && selected instanceof mod.AppLifecycleAdapter),
    'G6 adapter contract (NHI C3 — stock embeds byte-identical): omitting '
      + 'hostContext must keep today\'s HtmlAdapter selection; the app adapter '
      + 'is opt-in only',
  );
});

test('G6 R-B: hostContext is Rule-11-strict at the selection seam — non-enum throws TypeError', () => {
  assert.throws(
    () => SHARCContainer._selectLifecycleAdapter(null, 'banana'),
    TypeError,
    'G6 adapter contract (Rule-11/13 pattern): hostContext is a strict enum '
      + "['web','app'] — an unknown value must throw TypeError at the "
      + 'selection chokepoint (constructor validation forwards here), not '
      + 'silently fall back to web and strand the host INPUT with no consumer',
  );
});
