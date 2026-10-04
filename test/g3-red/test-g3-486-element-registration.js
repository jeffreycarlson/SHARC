#!/usr/bin/env node

/**
 * G3 red contract R1/R2/R3/R10 (#486): web-mode element registration with the
 * OM SDK for Web, as an integrator per the OMID web integration guide.
 *
 * Designed contract (ADR 2026-10-04-omid-web-element-registration):
 *   - Context.setSlotElement(container iframe) BEFORE `new AdSession(context)`;
 *     the session client sends the slot only from its constructor
 *     (omid-session-client-v1.js 1.6.6 :1156, :1298-1306).
 *   - AdSession.setElementBounds({x:0, y:0, width, height}) BEFORE start():
 *     the creative fills the iframe, bounds are relative to the slot element
 *     (AdSession JSDoc, docs.iabtechlab.com/omsdk-1.5/js/AdSession.html;
 *     omweb `Mb` adds them to the slot's client rect). An iframe slot is not
 *     measured at all without bounds (omweb `Kb`/`Ib`; probe variant H).
 *   - Re-send bounds whenever the iframe's CSS-pixel size changes (container
 *     placementChange, effective-visibility change, ResizeObserver), deduped;
 *     never on scroll (bounds are slot-relative; omweb's own observer tracks
 *     position).
 *   - No `omid-element` class: it is omweb's discovery fallback when no slot
 *     is set, and >1 such element on a page is an omweb error (`Jb`).
 *
 * RED on main 655cab5: _createSession never calls setSlotElement or
 * setElementBounds (it calls registerAdView, which the real client lacks), so
 * the service path measures nothing.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { runPlacement, layOut, startedSession, DEFAULT_IFRAME_RECT } from './g3-harness.js';

const idx = (calls, api) => calls.findIndex((x) => x.api === api);

test('#486 R1: Context.setSlotElement(container iframe) before new AdSession, so the slot reaches the service', async () => {
  const r = await runPlacement();
  const s = startedSession(r.standin);
  assert.ok(s, 'an OM SDK AdSession started');
  const setSlot = r.standin.calls.find((x) => x.api === 'Context.setSlotElement');
  assert.ok(setSlot, 'G3 #486: the bridge must call Context.setSlotElement (the session client\'s only '
    + 'slot API); calls made: ' + JSON.stringify(r.standin.calls.map((x) => x.api)));
  assert.equal(setSlot.args[0], r.c._iframe, 'the slot element is the container\'s creative iframe');
  assert.equal(s.slot, r.c._iframe,
    'the slot must be set before `new AdSession(context)`: the client sends it only from its constructor');
});

test('#486 R1: setElementBounds({x:0,y:0,width,height}) of the iframe, before start()', async () => {
  const r = await runPlacement();
  const calls = r.standin.calls;
  const b = calls.find((x) => x.api === 'AdSession.setElementBounds');
  assert.ok(b, 'G3 #486: an <iframe> slot is never measured without setElementBounds (omweb Kb/Ib)');
  assert.deepEqual(b.args[0], { x: 0, y: 0, width: DEFAULT_IFRAME_RECT.width, height: DEFAULT_IFRAME_RECT.height },
    'bounds are slot-relative CSS px covering the whole iframe');
  assert.ok(idx(calls, 'AdSession.setElementBounds') < idx(calls, 'AdSession.start'),
    'first bounds precede start(), so geometry is available when the session starts');
});

test('#486 R2: bounds follow iframe size changes (placementChange), deduped', async () => {
  const r = await runPlacement({
    async whileActive({ c }) {
      layOut(c._iframe, { x: 0, y: 100, width: 300, height: 600 });
      c.notifyPlacementChange({ width: 300, height: 600 });
      c.notifyPlacementChange({ width: 300, height: 600 });
    },
  });
  const bounds = r.standin.calls.filter((x) => x.api === 'AdSession.setElementBounds').map((x) => x.args[0]);
  assert.deepEqual(bounds, [
    { x: 0, y: 0, width: 300, height: 250 },
    { x: 0, y: 0, width: 300, height: 600 },
  ], 'one bounds update per real size change, none for an unchanged size (got ' + JSON.stringify(bounds) + ')');
});

test('#486 R2: bounds follow a 0x0 -> laid-out iframe (preloaded display:none), via effective-visibility change', async () => {
  const r = await runPlacement({
    iframeRect: { x: 0, y: 100, width: 0, height: 0 },
    async whileActive({ c }) {
      layOut(c._iframe, DEFAULT_IFRAME_RECT);
      c._onRawIntersection(0.5);
    },
  });
  const bounds = r.standin.calls.filter((x) => x.api === 'AdSession.setElementBounds').map((x) => x.args[0]);
  assert.deepEqual(bounds.at(-1), { x: 0, y: 0, width: 300, height: 250 },
    'the iframe gaining a size is re-sent as bounds (got ' + JSON.stringify(bounds) + ')');
});

// Baseline pin, GREEN today: guards the decision not to add the class.
test('#486 R3: the iframe never carries the omid-element class (baseline pin, green today)', async () => {
  const r = await runPlacement();
  assert.equal(r.c._iframe.classList.contains('omid-element'), false,
    'omid-element is omweb\'s no-slot fallback; with a slot set it is redundant and two on a page is an omweb error');
});

test('#486 R10 (G3, CI tier): a service-path vendor receives geometryChange with a correct adView', async () => {
  const r = await runPlacement({
    async whileActive({ standin }) { standin.remeasure(); },
  });
  const geo = r.serviceEvents.filter((e) => e.type === 'geometryChange');
  assert.ok(geo.length > 0,
    'G3 #486: DV/Pixalate measure through the service channel only; service-path geometryChange count must be > 0 (got 0)');
  assert.equal(geo[0].data.adView.percentageInView, 100, 'fully visible 300x250 ad reads 100% in view');
  assert.deepEqual(
    { x: geo[0].data.adView.geometry.x, y: geo[0].data.adView.geometry.y,
      width: geo[0].data.adView.geometry.width, height: geo[0].data.adView.geometry.height },
    DEFAULT_IFRAME_RECT, 'adView.geometry is the iframe\'s viewport rect');
  const imp = r.serviceEvents.find((e) => e.type === 'impression');
  assert.ok(imp && imp.data.adView && imp.data.viewport,
    'the service-path impression carries viewport + adView (got ' + JSON.stringify(imp && imp.data) + ')');
});
