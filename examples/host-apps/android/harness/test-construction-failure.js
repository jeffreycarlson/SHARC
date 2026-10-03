import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { compareReportVerdicts } from '../../../../tools/creative-validator/src/regression.js';

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const source = html.slice(html.indexOf('function reportRow('), html.indexOf('window.__sharcHarnessSetHostLifecycle'));
const message = 'SHARCContainer cannot mint root nonce: requires a secure context';

for (const phase2 of [undefined, 'lifecycle', 'port-exfil', 'expand-collapse']) {
  test(`construction failure stays explicit for ${phase2 || 'URL'} rows`, async () => {
    const context = vm.createContext({
      SHARCContainer: class { constructor() { throw new Error(message); } },
      document: { createElement: () => ({}) },
      placementHost: { replaceChildren() {}, appendChild() {} },
      activeContainer: null,
      activeObservation: null,
      setTimeout,
      clearTimeout,
    });
    vm.runInContext(source, context);
    const testCase = {
      source: { sourceFile: 'synthetic-construction', rowIndex: 0, bidder: 'synthetic', mtype: 1 },
      ids: { bidId: 'construction-negative', crid: 'synthetic' },
      phase2,
      requireSharcInit: true,
    };
    const row = JSON.parse(JSON.stringify(await context.runCase(testCase)));
    assert.deepEqual(row.outcome, {
      status: 'failed', bucket: 'container-construction-failed', reason: message,
    });
    const baseline = { ...row, outcome: {
      status: 'failed', bucket: 'declared-sharc-no-handshake', reason: 'createSession timeout',
    } };
    assert.equal(compareReportVerdicts([baseline], [row]).totals.verdictChanges, 1);
  });
}

const runner = readFileSync(new URL('../../../../scripts/run-android-webview-harness.js', import.meta.url), 'utf8');
const mainSource = runner.slice(runner.indexOf('async function main()'), runner.indexOf('main().catch'));

for (const failedPort of [null, 18867]) {
  test(`runner cleans up only configured harness reverses (${failedPort || 'launch failure'})`, async () => {
    const calls = [];
    const context = vm.createContext({
      process: { argv: [], exitCode: 0 },
      console,
      parseArgs: () => ({ skipBuild: true, apk: 'fixture.apk' }),
      ensureTool() {},
      existsSync: () => true,
      resolve: (...parts) => parts.join('/'),
      repoRoot: '.',
      pickDevice: () => 'synthetic-device',
      hostPort: 18865, rendererPort: 18866, creativePort: 18867, creativeRendererPort: 18868,
      spawnServer: (port) => port,
      stop: async (port) => calls.push(['stop', port]),
      waitForServer: async () => {},
      adb: (device, args) => {
        assert.equal(device, 'synthetic-device');
        calls.push(args);
        if (args[0] === 'reverse' && args[1] === `tcp:${failedPort}`) {
          throw new Error('synthetic reverse failure');
        }
      },
      launchAndCollect: async () => { throw new Error('synthetic launch failure'); },
    });
    vm.runInContext(mainSource, context);
    await assert.rejects(context.main(), failedPort
      ? /Could not configure adb reverse for harness port 18867/
      : /synthetic launch failure/);
    const removed = calls.filter((args) => args[0] === 'reverse' && args[1] === '--remove');
    assert.deepEqual(JSON.parse(JSON.stringify(removed)), (failedPort
      ? [18865, 18866] : [18865, 18866, 18867, 18868])
      .map((port) => ['reverse', '--remove', `tcp:${port}`]));
    assert.equal(calls.some((args) => args.includes('--remove-all')), false);
    assert.equal(calls.filter((args) => args[0] === 'stop').length, 2);
    if (failedPort) assert.equal(calls.some((args) => args[0] === 'install'), false);
  });
}
