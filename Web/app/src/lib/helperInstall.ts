// What to tell someone who could use the TotTag Helper but has not installed it, or has an old one.
//
// Two pieces have to be installed, and running them together is the usual way this gets confusing:
// the TotTag Helper program, from this repository's releases, and its browser extension, from the
// Chrome Web Store. Neither does anything alone. Nothing here is offered where the browser could not
// use it: the extension needs a Chromium browser on a computer.

import { LATEST_HELPER_RELEASE } from './helper.ts';

export type HostOs = 'macos' | 'windows' | 'linux' | 'other';

/** The extension's Chrome Web Store listing, by its ID. */
export const EXTENSION_STORE_URL = 'https://chromewebstore.google.com/detail/mdcklmmdjhaedkbclflpiehpcmofhcfn';

/** Every release of the helper, for when this page does not know the newest. */
export const HELPER_RELEASES_URL = 'https://github.com/hedgetechllc/tottag-dashboard/releases';

/**
 * A file from the newest helper release. By its tag rather than `releases/latest`, which is whatever
 * this repository released last and need not be the helper.
 */
const download = (asset: string, latest = LATEST_HELPER_RELEASE) =>
  (latest ? `${HELPER_RELEASES_URL}/download/tottag-helper-v${latest}/${asset}` : HELPER_RELEASES_URL);

export function detectOs(): HostOs {
  if (typeof navigator === 'undefined') return 'other';
  const platform = ((navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform
    ?? navigator.platform ?? '').toLowerCase();
  const agent = navigator.userAgent.toLowerCase();
  if (/android|iphone|ipad|cros/.test(agent)) return 'other';
  if (platform.includes('mac')) return 'macos';
  if (platform.includes('win')) return 'windows';
  if (platform.includes('linux')) return 'linux';
  return 'other';
}

export interface InstallStep {
  readonly title: string;
  readonly detail: string;
  /** A command to type, where the step is one. */
  readonly command?: string;
  /** A download or a page. */
  readonly links?: ReadonlyArray<{ readonly label: string; readonly href: string }>;
}

export interface InstallGuide {
  readonly osLabel: string;
  /** False where there is no helper for this system. */
  readonly available: boolean;
  /** Said first, where something about this system limits the helper. */
  readonly caveat: string | null;
  readonly steps: readonly InstallStep[];
}

const extensionStep: InstallStep = {
  title: 'Add the TotTag Helper extension',
  detail: 'From the Chrome Web Store, in Chrome or Edge. It only passes messages between this page and the program.',
  links: [{ label: 'Open the Chrome Web Store', href: EXTENSION_STORE_URL }],
};

const reloadStep: InstallStep = {
  title: 'Reload this page',
  detail: 'The bottom of the menu then says the TotTag Helper finds tags nearby and plugged in.',
};

const problemStep = (command: string): InstallStep => ({
  title: 'If it does not work',
  detail: 'This command says which browsers the helper is registered with, and whether it runs:',
  command,
});

/**
 * How to install the helper on this computer. `program` alone leaves out the extension, for someone
 * who has it already: installing the program for the first time, or replacing an old one.
 */
export function installGuide(os: HostOs = detectOs(), { program = false, latest = LATEST_HELPER_RELEASE } = {}): InstallGuide {
  const keep = (steps: InstallStep[]) => (program ? steps.filter((step) => step !== extensionStep) : steps);
  switch (os) {
    case 'macos':
      return {
        osLabel: 'macOS',
        available: true,
        caveat: null,
        steps: keep([
          {
            title: 'Install the TotTag Helper program',
            detail: 'Open the downloaded installer and follow its steps. It needs macOS 13 or later, and is signed and '
              + 'notarized by Apple. The first time this page looks for tags, macOS asks whether the TotTag Helper may use '
              + 'Bluetooth: allow it.',
            links: [{ label: 'Download for macOS', href: download('TotTag-Helper-macOS.pkg', latest) }],
          },
          extensionStep,
          reloadStep,
          problemStep('"/Library/Application Support/TotTag/TotTag Helper.app/Contents/MacOS/tottag-helper" doctor'),
        ]),
      };
    case 'windows':
      return {
        osLabel: 'Windows',
        available: true,
        caveat: null,
        steps: keep([
          {
            title: 'Install the TotTag Helper program',
            detail: 'Run the downloaded installer. It installs for you only and needs no administrator rights. If Windows '
              + 'says it protected your PC, choose More info, then Run anyway.',
            links: [{ label: 'Download for Windows', href: download('TotTag-Helper-Windows.exe', latest) }],
          },
          extensionStep,
          reloadStep,
          problemStep('& "$env:LOCALAPPDATA\\Programs\\TotTag Helper\\tottag-helper.exe" doctor'),
        ]),
      };
    case 'linux':
      return {
        osLabel: 'Linux',
        available: true,
        caveat: 'Chromium installed as a snap cannot start programs like this one. Use Chrome, Edge, or a Chromium package from your distribution.',
        steps: keep([
          {
            title: 'Install the TotTag Helper program',
            detail: 'On Debian or Ubuntu, install the .deb for your processor: amd64 for most computers, arm64 for a '
              + 'Raspberry Pi or other ARM computer. Elsewhere, unpack the .tar.gz and run its install.sh with sudo.',
            command: 'sudo apt install ./tottag-helper_amd64.deb',
            links: [
              { label: 'Download the .deb (amd64)', href: download('tottag-helper_amd64.deb', latest) },
              { label: '.deb (arm64)', href: download('tottag-helper_arm64.deb', latest) },
              { label: 'Other downloads', href: latest ? `${HELPER_RELEASES_URL}/tag/tottag-helper-v${latest}` : HELPER_RELEASES_URL },
            ],
          },
          extensionStep,
          reloadStep,
          problemStep('tottag-helper doctor'),
        ]),
      };
    default:
      return {
        osLabel: 'this computer',
        available: false,
        caveat: 'The TotTag Helper runs on macOS, Windows and Linux computers.',
        steps: [],
      };
  }
}
