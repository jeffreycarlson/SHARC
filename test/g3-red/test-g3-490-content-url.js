#!/usr/bin/env node

/**
 * G3 red contract R7 (#490): contentUrl never defaults to window.location.href.
 *
 * Designed contract: contentUrl = operator `contentUrl` option, else the
 * redaction-respecting environmentData.publisherContext.pageUrl (when
 * non-empty), else null. It is passed as the Context constructor's third
 * argument, the only path the pinned client has (session client 1.6.6
 * :725-738 has no setContentUrl; the AdSession constructor sends it, :1158).
 * The OMID web guide asks integrators to "exclude any sensitive or personally
 * identifying information" from the content URL
 * (interactiveadvertisingbureau.github.io/Open-Measurement-SDKJS, step 2).
 * OMID 1.5 defines contentUrl on the web as "the URL of the top-level web
 * page", i.e. the same datum publisherContext.pageUrl redacts.
 *
 * RED on main 655cab5: _createSession computes
 * `options.contentUrl || window.location.href` and hands it to
 * Context.setContentUrl, which the pinned client lacks; nothing reaches the
 * Context constructor. With a client that does implement setContentUrl, the
 * full page URL leaks past a redacted publisherContext.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { runPlacement, startedSession, relayed, PUBLISHER_PAGE_URL } from './g3-harness.js';

const ctxCall = (r) => r.standin.calls.filter((x) => x.api === 'Context').at(-1);
const REDACTED = { pageUrl: '', domain: '', bundleId: '', platform: 'web' };

test('#490 R7: an operator-configured contentUrl is the Context constructor\'s contentUrl', async () => {
  const r = await runPlacement({ contentUrl: 'https://content.example/article' });
  assert.equal(ctxCall(r).args[2], 'https://content.example/article',
    'contentUrl is Context constructor argument 3 (got args ' + JSON.stringify(ctxCall(r).args.slice(2)) + ')');
  assert.equal(startedSession(r.standin).contentUrl, 'https://content.example/article');
  assert.equal(relayed(r, 'sessionStart')[0].data.contentUrl, 'https://content.example/article',
    'the SDK\'s sessionStart contentUrl is relayed unchanged');
});

test('#490 R7: no operator value -> the publisher\'s redacted publisherContext.pageUrl', async () => {
  const r = await runPlacement({
    environmentData: { publisherContext: { pageUrl: 'https://publisher.example/', domain: 'publisher.example', bundleId: '', platform: 'web' } },
  });
  assert.equal(startedSession(r.standin).contentUrl, 'https://publisher.example/',
    'contentUrl follows publisherContext.pageUrl (got ' + JSON.stringify(startedSession(r.standin).contentUrl) + ')');
});

// Baseline pin, GREEN today (the pinned client drops contentUrl entirely).
test('#490 R7: publisher redacts pageUrl, no operator value -> contentUrl null (baseline pin, green today)', async () => {
  const r = await runPlacement({ environmentData: { publisherContext: REDACTED } });
  assert.equal(startedSession(r.standin).contentUrl, null);
  assert.notEqual(relayed(r, 'sessionStart')[0].data.contentUrl, PUBLISHER_PAGE_URL);
});

test('#490 R7: a session client that implements Context.setContentUrl still never receives location.href', async () => {
  const r = await runPlacement({
    environmentData: { publisherContext: REDACTED },
    patchStandin(win, standin) {
      const Ctx = win.OmidSessionClient.default.Context;
      Ctx.prototype.setContentUrl = function (u) {
        standin.calls.push({ api: 'Context.setContentUrl(future client)', args: [u] });
        this.contentUrl = u;
      };
    },
  });
  const leaked = r.standin.calls.filter((x) => (x.args || []).some((a) => a === PUBLISHER_PAGE_URL));
  assert.deepEqual(leaked.map((x) => x.api), [],
    '#490: the unredacted page URL ' + PUBLISHER_PAGE_URL + ' must never reach the OM SDK when the publisher redacted it');
});
