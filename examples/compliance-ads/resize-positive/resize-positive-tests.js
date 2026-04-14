// ==============================  MRAID INIT  ================================
if (document.readyState === 'complete') {
  readyCheck();
} else {
    window.addEventListener('load', readyCheck, false);
}

function readyCheck() {
    if (window.MRAID_ENV) {
        console.log('Version: ' + window.MRAID_ENV.version +
            ' SDK: ' + window.MRAID_ENV.sdk +
            ' SDKv: ' + window.MRAID_ENV.sdkVersion);
    } else {
        console.error('MRAID_ENV NOT FOUND');
    }

    logDiv = document.getElementById('resize_positive_tests_log');
    logDiv.style = 'margin:10px';

    var _mraid = window.mraid;

    if (!_mraid) {
        logErrorOnUi('window.mraid not found.');
        return;
    }

    if (_mraid.getState() === 'loading') {
        _mraid.addEventListener('ready', function () {
            startTests(_mraid, function () {
                console.log('[ALL POSITIVE RESIZE TESTS FINISHED]');
            }, 3000, logInfoOnUi, logErrorOnUi);
        });
    } else {
        startTests(_mraid, function () {
            console.log('[ALL POSITIVE RESIZE TESTS FINISHED]');
        }, 3000, logInfoOnUi, logErrorOnUi);
    }
}

var logDiv;

function logOnUi(color, message) {
    var messageDiv = document.createElement('div');
    messageDiv.innerText = '[' + new Date().toLocaleString() + '] ' + message;
    messageDiv.style = 'width:100%;padding: 10px 0px;padding-right:10px;color:' + color;
    logDiv.appendChild(messageDiv);
}

function logInfoOnUi(message) {
    logOnUi('dodgerblue', message);
    console.log(message);
}

function logErrorOnUi(message) {
    logOnUi('tomato', message);
    console.error(message);
}

// ============================================================================

/**
 * Sequentially executes resize positive tests. Covers cases when resize
 * operations should succeed.
 *
 * @param mraid MRAID instance to use.
 * @param done Callback function, executed once all tests ran.
 * @param waitTimeout How long to wait for events.
 * @param log Callback that should get log strings.
 * @param error Callback that receives error strings.
 */
function startTests(mraid, done, waitTimeout, log, error) {
    this.error = error || console.error;
    this.log = log || console.log;

    var testQueue = [];
    var currentTest = 0;

    function runNext() {
        if (currentTest >= testQueue.length) {
            log('=== ALL POSITIVE RESIZE TESTS COMPLETE ===');
            if (done) done();
            return;
        }
        var test = testQueue[currentTest];
        currentTest++;
        log('--- Test: ' + test.description + ' ---');
        test.run(function () {
            runNext();
        });
    }

    // ===========================  TEST 1  ====================================
    // Basic resize: set properties, call resize(), verify stateChange + sizeChange
    testQueue.push({
        description: 'Basic resize to 320x480 with top-right close',
        run: function (next) {
            var resolved = false;
            var stateOk = false;
            var sizeOk = false;

            function checkDone() {
                if (stateOk && sizeOk && !resolved) {
                    resolved = true;
                    mraid.removeEventListener('stateChange', onState);
                    mraid.removeEventListener('sizeChange', onSize);
                    clearTimeout(timer);

                    // Verify getState
                    if (mraid.getState() === 'resized') {
                        log('CHECK: getState() === "resized" after resize');
                    } else {
                        error('FAIL: getState() === "' + mraid.getState() + '", expected "resized"');
                    }

                    // Verify getCurrentPosition
                    var pos = mraid.getCurrentPosition();
                    if (pos.width === 320 && pos.height === 480) {
                        log('CHECK: getCurrentPosition() width=320, height=480');
                    } else {
                        error('FAIL: getCurrentPosition() width=' + pos.width + ', height=' + pos.height);
                    }

                    // Verify getMaxSize unchanged
                    var maxSize = mraid.getMaxSize();
                    log('CHECK: getMaxSize() unchanged = ' + JSON.stringify(maxSize));

                    // Now close back to default
                    closeToDefault(mraid, waitTimeout, log, error, next);
                }
            }

            function onState(state) {
                if (state === 'resized') {
                    log('CHECK: stateChange("resized") received');
                    stateOk = true;
                    checkDone();
                }
            }

            function onSize(w, h) {
                if (w === 320 && h === 480) {
                    log('CHECK: sizeChange(320, 480) received');
                    sizeOk = true;
                    checkDone();
                } else {
                    error('FAIL: sizeChange(' + w + ', ' + h + '), expected (320, 480)');
                }
            }

            var timer = setTimeout(function () {
                if (!resolved) {
                    resolved = true;
                    mraid.removeEventListener('stateChange', onState);
                    mraid.removeEventListener('sizeChange', onSize);
                    error('FAIL: Timeout waiting for resize stateChange/sizeChange');
                    next();
                }
            }, waitTimeout);

            mraid.addEventListener('stateChange', onState);
            mraid.addEventListener('sizeChange', onSize);

            mraid.setResizeProperties({
                width: 320,
                height: 480,
                offsetX: 0,
                offsetY: 0,
                customClosePosition: 'top-right',
                allowOffscreen: false
            });
            mraid.resize();
        }
    });

    // ===========================  TEST 2  ====================================
    // Resize with offset: verify targetPosition passed through
    testQueue.push({
        description: 'Resize with offset (offsetX=10, offsetY=-50)',
        run: function (next) {
            var resolved = false;

            function onState(state) {
                if (state === 'resized' && !resolved) {
                    resolved = true;
                    mraid.removeEventListener('stateChange', onState);
                    clearTimeout(timer);

                    log('CHECK: stateChange("resized") after offset resize');
                    var pos = mraid.getCurrentPosition();
                    log('CHECK: getCurrentPosition() = ' + JSON.stringify(pos));

                    closeToDefault(mraid, waitTimeout, log, error, next);
                }
            }

            var timer = setTimeout(function () {
                if (!resolved) {
                    resolved = true;
                    mraid.removeEventListener('stateChange', onState);
                    error('FAIL: Timeout waiting for offset resize');
                    next();
                }
            }, waitTimeout);

            mraid.addEventListener('stateChange', onState);
            mraid.setResizeProperties({
                width: 320,
                height: 480,
                offsetX: 10,
                offsetY: -50,
                customClosePosition: 'top-right',
                allowOffscreen: false
            });
            mraid.resize();
        }
    });

    // ===========================  TEST 3  ====================================
    // Close from resized: verify return to default state and original position
    testQueue.push({
        description: 'Close from resized returns to default with original position',
        run: function (next) {
            var resolved = false;
            var defaultPos = mraid.getDefaultPosition();

            // First resize
            function onResized(state) {
                if (state === 'resized') {
                    mraid.removeEventListener('stateChange', onResized);
                    log('CHECK: Resized. Now calling close()...');

                    // Listen for close -> default
                    mraid.addEventListener('stateChange', onDefault);
                    mraid.close();
                }
            }

            function onDefault(state) {
                if (state === 'default' && !resolved) {
                    resolved = true;
                    mraid.removeEventListener('stateChange', onDefault);
                    clearTimeout(timer);

                    if (mraid.getState() === 'default') {
                        log('CHECK: getState() === "default" after close from resized');
                    } else {
                        error('FAIL: getState() === "' + mraid.getState() + '" after close');
                    }

                    var pos = mraid.getCurrentPosition();
                    if (pos.width === defaultPos.width && pos.height === defaultPos.height) {
                        log('CHECK: Position reset to default (' + pos.width + 'x' + pos.height + ')');
                    } else {
                        error('FAIL: Position not reset. Got ' + pos.width + 'x' + pos.height +
                              ', expected ' + defaultPos.width + 'x' + defaultPos.height);
                    }
                    next();
                }
            }

            var timer = setTimeout(function () {
                if (!resolved) {
                    resolved = true;
                    mraid.removeEventListener('stateChange', onResized);
                    mraid.removeEventListener('stateChange', onDefault);
                    error('FAIL: Timeout in close-from-resized test');
                    next();
                }
            }, waitTimeout * 2);

            mraid.addEventListener('stateChange', onResized);
            mraid.setResizeProperties({
                width: 320,
                height: 480,
                offsetX: 0,
                offsetY: 0,
                customClosePosition: 'top-right',
                allowOffscreen: false
            });
            mraid.resize();
        }
    });

    // ===========================  TEST 4  ====================================
    // All 8 customClosePosition values
    var closePositions = [
        'top-left', 'top-right', 'top-center',
        'bottom-left', 'bottom-right', 'bottom-center',
        'center'
    ];

    closePositions.forEach(function (pos) {
        testQueue.push({
            description: 'Resize with customClosePosition="' + pos + '"',
            run: function (next) {
                var resolved = false;

                function onState(state) {
                    if (state === 'resized' && !resolved) {
                        resolved = true;
                        mraid.removeEventListener('stateChange', onState);
                        clearTimeout(timer);
                        log('CHECK: Resize succeeded with customClosePosition="' + pos + '"');
                        closeToDefault(mraid, waitTimeout, log, error, next);
                    }
                }

                var timer = setTimeout(function () {
                    if (!resolved) {
                        resolved = true;
                        mraid.removeEventListener('stateChange', onState);
                        error('FAIL: Timeout for customClosePosition="' + pos + '"');
                        next();
                    }
                }, waitTimeout);

                mraid.addEventListener('stateChange', onState);
                mraid.setResizeProperties({
                    width: 200,
                    height: 200,
                    offsetX: 0,
                    offsetY: 0,
                    customClosePosition: pos,
                    allowOffscreen: false
                });
                mraid.resize();
            }
        });
    });

    // ===========================  TEST 5  ====================================
    // Resize from expanded state should error
    testQueue.push({
        description: 'Resize from expanded state fires error event',
        run: function (next) {
            var resolved = false;

            // First expand
            function onExpanded(state) {
                if (state === 'expanded') {
                    mraid.removeEventListener('stateChange', onExpanded);
                    log('CHECK: Expanded. Now attempting resize()...');

                    // Listen for error
                    function onError(message, action) {
                        if (!resolved && action === 'resize') {
                            resolved = true;
                            mraid.removeEventListener('error', onError);
                            clearTimeout(timer);
                            log('CHECK: Error fired for resize from expanded: "' + message + '"');

                            // Close back to default
                            mraid.addEventListener('stateChange', function onClose(state) {
                                if (state === 'default') {
                                    mraid.removeEventListener('stateChange', onClose);
                                    next();
                                }
                            });
                            mraid.close();
                        }
                    }

                    mraid.addEventListener('error', onError);
                    mraid.setResizeProperties({
                        width: 200,
                        height: 200,
                        offsetX: 0,
                        offsetY: 0
                    });
                    mraid.resize();
                }
            }

            var timer = setTimeout(function () {
                if (!resolved) {
                    resolved = true;
                    mraid.removeEventListener('stateChange', onExpanded);
                    error('FAIL: Timeout in resize-from-expanded test');
                    // Try to close back to default
                    mraid.close();
                    setTimeout(next, 500);
                }
            }, waitTimeout * 2);

            mraid.addEventListener('stateChange', onExpanded);
            mraid.expand();
        }
    });

    // Start the test sequence
    runNext();
}

// ================================ HELPERS ====================================

/**
 * Closes from any state back to default, waiting for stateChange("default").
 */
function closeToDefault(mraid, timeout, log, error, next) {
    var resolved = false;

    function onState(state) {
        if (state === 'default' && !resolved) {
            resolved = true;
            mraid.removeEventListener('stateChange', onState);
            clearTimeout(timer);
            log('CHECK: Returned to default state after close');
            next();
        }
    }

    var timer = setTimeout(function () {
        if (!resolved) {
            resolved = true;
            mraid.removeEventListener('stateChange', onState);
            error('FAIL: Timeout waiting for close -> default');
            next();
        }
    }, timeout);

    mraid.addEventListener('stateChange', onState);
    mraid.close();
}
// ============================================================================
