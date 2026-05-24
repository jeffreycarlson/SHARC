/**
 * test-creative-protocol-placement-type.js — issue #59 regression
 *
 * Covers SHARCCreativeProtocol#setPlacementType validation. The creative
 * protocol should only accept placement types supported by createSession.
 *
 * Runs in Node after `npm run build`.
 */

const { SHARCCreativeProtocol, ProtocolMessages } = await import('../../dist/sharc-protocol.mjs');

let failures = 0;
function assert(condition, message) {
  if (condition) {
    console.log('  ✓', message);
  } else {
    console.error('  ✗', message);
    failures++;
  }
}

function assertThrowsTypeError(fn, pattern, message) {
  try {
    fn();
    console.error('  ✗', message);
    failures++;
  } catch (err) {
    assert(err instanceof TypeError, `${message} throws TypeError`);
    assert(pattern.test(err.message), `${message} error message is actionable`);
  }
}

async function captureCreateSessionPlacementType(proto) {
  let sent = null;
  proto._portReadyPromise = Promise.resolve();
  proto._sendMessage = (type, args) => {
    sent = { type, args };
    return Promise.resolve();
  };
  await proto.createSession();
  assert(sent && sent.type === ProtocolMessages.CREATE_SESSION,
    'createSession sends SHARC:Creative:createSession');
  return sent.args.placementType;
}

console.log('test-creative-protocol-placement-type.js — issue #59 regression\n');

// -- 1. Defaults to inline --------------------------------------------------
{
  console.log('1. createSession defaults placementType to inline');
  const proto = new SHARCCreativeProtocol();
  const placementType = await captureCreateSessionPlacementType(proto);
  assert(placementType === 'inline',
    'default createSession placementType is inline');
}

// -- 2. Accepts supported placement types ----------------------------------
{
  console.log('\n2. setPlacementType accepts inline and interstitial');
  const inlineProto = new SHARCCreativeProtocol();
  inlineProto.setPlacementType('inline');
  const inlinePlacementType = await captureCreateSessionPlacementType(inlineProto);
  assert(inlinePlacementType === 'inline',
    'setPlacementType("inline") flows into createSession');

  const interstitialProto = new SHARCCreativeProtocol();
  interstitialProto.setPlacementType('interstitial');
  const interstitialPlacementType = await captureCreateSessionPlacementType(interstitialProto);
  assert(interstitialPlacementType === 'interstitial',
    'setPlacementType("interstitial") flows into createSession');
}

// -- 3. Rejects unsupported placement types --------------------------------
{
  console.log('\n3. setPlacementType rejects unsupported values');
  const proto = new SHARCCreativeProtocol();
  proto.setPlacementType('interstitial');

  for (const value of ['banner', '', null, undefined]) {
    assertThrowsTypeError(
      () => proto.setPlacementType(value),
      /placementType must be 'inline' or 'interstitial'/,
      `setPlacementType(${String(value)})`,
    );
  }

  const placementType = await captureCreateSessionPlacementType(proto);
  assert(placementType === 'interstitial',
    'rejected placementType does not mutate the previous valid value');
}

if (failures > 0) {
  console.error(`\n✗ ${failures} creative protocol placement type assertion(s) failed.`);
  process.exit(1);
}

console.log('\n✓ All creative protocol placement type assertions passed.');
