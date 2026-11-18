/**
 * TotTag Helper — extension service worker.
 *
 * This file is deliberately as close to nothing as it can be, and that is a design decision
 * rather than an unfinished state.
 */

const HOST_NAME = 'net.tottag.helper';

/**
 * Relays a page-opened port to a helper port, in both directions, for as long as the page keeps
 * it open.
 *
 * A port, never a one-off message, because Bluetooth outlives a request: a connection to a tag,
 * a scan, and a stream of notifications all continue after the request that started them, and
 * an extension cannot push a message to a web page except down a port the page itself opened.
 * One page port is one helper process, which ends when the page closes the port or goes away.
 */
chrome.runtime.onConnectExternal.addListener((pagePort) => {
  let helperPort;
  try {
    helperPort = chrome.runtime.connectNative(HOST_NAME);
  } catch (error) {
    safePost(pagePort, helperUnavailable(String(error)));
    pagePort.disconnect();
    return;
  }

  let closed = false;
  const closeAll = () => {
    if (closed) return;
    closed = true;
    try { helperPort.disconnect(); } catch { /* already gone */ }
    try { pagePort.disconnect(); } catch { /* already gone */ }
  };

  // Everything either side says goes straight through. This file does not interpret either.
  helperPort.onMessage.addListener((message) => safePost(pagePort, message));
  pagePort.onMessage.addListener((message) => {
    try {
      helperPort.postMessage(message);
    } catch (error) {
      safePost(pagePort, helperUnavailable(String(error)));
      closeAll();
    }
  });

  helperPort.onDisconnect.addListener(() => {
    const error = chrome.runtime.lastError;
    safePost(pagePort, helperUnavailable(error ? error.message : 'The TotTag Helper stopped.'));
    closeAll();
  });
  pagePort.onDisconnect.addListener(closeAll);
});

function safePost(port, message) {
  try {
    port.postMessage(message);
  } catch {
    // The page has gone
  }
}

/**
 * The one message this file writes itself.
 *
 * "Specified native messaging host not found" means the helper program is not installed, which
 * is an ordinary state, and the page falls back to choosing tags itself. Anything else is a real
 * fault and says so.
 */
function helperUnavailable(message) {
  const notInstalled = /not found|forbidden|not registered/i.test(message ?? '');
  return {
    event: 'helperStopped',
    code: notInstalled ? 'helper-not-installed' : 'helper-failed',
    error: notInstalled
      ? 'The TotTag Helper program is not installed on this computer.'
      : `The TotTag Helper could not be reached: ${message}`,
  };
}
