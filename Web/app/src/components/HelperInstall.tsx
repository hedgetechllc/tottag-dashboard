// Offering the TotTag Helper: to install it where it could run but is not installed, and to update it
// where a newer one has been released. Shown at the foot of the menu, under what the helper is doing.

import { useEffect, useRef, useState } from 'react';
import { helperUpdateAvailable, LATEST_HELPER_RELEASE, type HelperState } from '../lib/helper.ts';
import { detectOs, installGuide } from '../lib/helperInstall.ts';

type Asking = { readonly title: string; readonly program: boolean };

/** What to offer for the helper's state, if anything: a line and the button that opens its steps. */
function offerFor(state: HelperState): { text: string | null; button: string; asking: Asking } | null {
  switch (state.status) {
    case 'absent':
      return {
        text: 'Find tags nearby and plugged in, several at a time, without Chrome\'s device chooser.',
        button: 'Install the TotTag Helper',
        asking: { title: 'Install the TotTag Helper', program: false },
      };
    case 'not-installed':
      return { text: null, button: 'Install the program', asking: { title: 'Install the TotTag Helper program', program: true } };
    case 'outdated':
      return { text: null, button: 'Install the latest', asking: { title: 'Update the TotTag Helper', program: true } };
    default:
      if (!helperUpdateAvailable(state.version)) return null;
      return {
        text: `TotTag Helper ${LATEST_HELPER_RELEASE} is available.`,
        button: 'Update',
        asking: { title: 'Update the TotTag Helper', program: true },
      };
  }
}

/** The line and button at the foot of the menu, and the steps they open. */
export function HelperOffer({ state }: { state: HelperState }) {
  const [asking, setAsking] = useState<Asking | null>(null);
  const offer = offerFor(state);
  // Nothing to offer a computer the helper does not run on
  if (!offer || !installGuide(detectOs()).available) return null;
  return (
    <>
      <p className="rail__note">
        {offer.text && <>{offer.text} </>}
        <button type="button" className="link" onClick={() => setAsking(offer.asking)}>{offer.button}</button>
      </p>
      {asking && <InstallSteps title={asking.title} program={asking.program} onClose={() => setAsking(null)} />}
    </>
  );
}

function InstallSteps({ title, program, onClose }: { title: string; program: boolean; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const guide = installGuide(detectOs(), { program });
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    return () => element?.close();
  }, []);

  const copy = (command: string) => {
    void navigator.clipboard?.writeText(command).then(() => {
      setCopied(command);
      setTimeout(() => setCopied(null), 1500);
    }, () => undefined);
  };

  return (
    <dialog ref={dialog} className="picker install" aria-labelledby="install-title"
      onCancel={(event) => { event.preventDefault(); onClose(); }}>
      <h2 id="install-title" className="panel__title">{title}</h2>
      <p className="panel__note">
        For {guide.osLabel}. {program
          ? 'The browser extension is already installed; only the program needs installing.'
          : 'Two pieces: the program, which reaches the tags, and a browser extension, which lets this page talk to it.'}
      </p>
      {guide.caveat && <p className="banner banner--warn">{guide.caveat}</p>}
      <ol className="install__steps">
        {guide.steps.map((step) => (
          <li key={step.title} className="install__step">
            <strong>{step.title}</strong>
            <span className="install__detail">{step.detail}</span>
            {step.command && (
              <span className="install__command">
                <code>{step.command}</code>
                <button type="button" className="link link--quiet" onClick={() => copy(step.command!)}>
                  {copied === step.command ? 'Copied' : 'Copy'}
                </button>
              </span>
            )}
            {step.links && (
              <span className="install__links">
                {step.links.map((link, index) => (
                  <a key={link.href} href={link.href} target="_blank" rel="noopener noreferrer"
                    className={index === 0 ? 'button button--small' : 'link'}>{link.label}</a>
                ))}
              </span>
            )}
          </li>
        ))}
      </ol>
      <div className="actions">
        <button type="button" className="button button--quiet" onClick={onClose}>Close</button>
      </div>
    </dialog>
  );
}
