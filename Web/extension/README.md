# TotTag Helper — browser extension

The TotTag Helper's browser extension: a relay between the dashboard page and the
[helper program](../tottag-helper) on the same computer. It contains no Bluetooth or USB logic and
should not acquire any.

## Why it is this small

The extension is distributed through the Chrome Web Store, so every change to
[`background.js`](background.js) needs a review, which takes hours to weeks. Keeping the extension
a dumb pipe means it is reviewed roughly once and then left alone, while the part that changes stays
free to change. If you are about to add something here, it almost certainly belongs in the helper.

It relays one port per page: the page opens it, the extension starts the helper for it, and
everything either side says goes straight through until the page closes it.

## Its ID

The `key` in [`manifest.json`](manifest.json) fixes the extension's ID,
`mdcklmmdjhaedkbclflpiehpcmofhcfn`, so that an unpacked copy loaded for development has the same ID
everywhere, and the helper (`install.ExtensionID` in
[`internal/install`](../tottag-helper/internal/install/install.go)) and the dashboard
(`HELPER_EXTENSION_ID` in [`app/src/lib/helper.ts`](../app/src/lib/helper.ts)) can name it.

That key is the Chrome Web Store item's own public key (Developer Dashboard → Package → View public
key), so the unpacked folder loads under the same ID as the published extension, and a Chrome
profile can hold only one of the two at a time. Leave `key` out of the zip uploaded to the store,
which sets it itself. The helper answers only the extension it names.

`externally_connectable` lists the dashboard's origin, `https://app.tottag.net`, and localhost for
development. Changing it means a new extension version and another review.

## Loading it for development

1. `chrome://extensions` → turn on Developer mode → **Load unpacked** → this folder.
2. From `Web/`, `npm run install-helper` builds the helper and registers it for this extension with
   every Chromium browser found; `npm run helper-doctor` checks that it took.
3. `npm run dev`, and open the dashboard.

Its service worker's console is under `chrome://extensions` → the extension → "service worker".
"Specified native messaging host not found" means the helper is not registered: run
`npm run helper-doctor`.
