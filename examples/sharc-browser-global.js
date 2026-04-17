/**
 * @fileoverview SHARC Browser Global Bundle
 *
 * Convenience IIFE entry that combines protocol, container, and creative
 * into a single <script> tag load. Sets window.SHARC with all three
 * namespaces so legacy HTML consumers on current main continue to work.
 *
 * Usage (legacy HTML):
 *   <script src="dist/sharc-browser-global.js"></script>
 *   <script>
 *     var container = new SHARC.Container({ ... });
 *   </script>
 *
 * For ESM consumers, use the individual module imports instead:
 *   import { SHARCContainer } from '@iabtechlab/sharc/sharc-container';
 */

// Re-export everything from the three core modules.
// The IIFE build bundles these together; each module's
// globalThis/window.SHARC assignment is idempotent, so loading
// all three in sequence builds up the full SHARC namespace.

export { SHARCProtocol, SHARCContainerProtocol, SHARCCreativeProtocol, SHARCProtocolBase, SHARCStateMachine, ProtocolMessages, ContainerMessages, CreativeMessages, ContainerStates, ErrorCodes, CREATIVE_QUERYABLE_STATES, STATE_TRANSITIONS, MESSAGES_REQUIRING_RESPONSE } from './sharc-protocol.js';
export { SHARCContainer, SHARC_VERSION, DEFAULT_TIMEOUTS } from './sharc-container.js';
export { SHARCCreativeSDK, sdk, SHARC } from './sharc-creative.js';
