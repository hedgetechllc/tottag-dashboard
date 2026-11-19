# Privacy policy — TotTag Helper extension

Last updated: 18 November 2026

The TotTag Helper extension collects no data, and sends nothing anywhere.

**What it does.** It passes messages between the TotTag dashboard (https://app.tottag.net)
and the TotTag Helper program, installed separately on the same computer. Those messages are
about the TotTag sensors the program finds nearby over Bluetooth or plugged into the computer
by USB, and the operations the dashboard asks for: reading a tag's battery and clock, writing
a deployment's schedule to it, and downloading what it has recorded.

**What it does not do.** It makes no network requests of its own. It keeps no record of what passes
through it. It has no analytics, no tracking, and no access to web pages other than the dashboard. It
cannot read browsing activity. Its only permission is native messaging, which it uses to start the
TotTag Helper program and talk to it.

**The TotTag Helper program.** The program the extension talks to has no network code: it works only
with the browser that starts it, and with Bluetooth and USB on this computer. When it scans for
Bluetooth devices it passes on only those whose names start with "TotTag", and it lists only USB
ports with a TotTag's USB identifiers. It keeps no record of the devices it finds or the data it
passes on. The only files it writes are the registrations its installer creates, so that browsers can
find it.

**What tags record.** A tag's recordings, which can show which tags were near one another and when, go
from the tag to the dashboard page in the browser, and from there only to the folder on this computer
that the user chooses. The dashboard keeps a list of recently used tags' identifiers, the deployment
being set up, and the chosen folder in the browser's own storage on this computer. Nothing is
uploaded. The dashboard itself is a static website served by GitHub Pages, whose own privacy statement
covers GitHub's server logs.

**Contact.** Questions about this policy: https://github.com/hedgetechllc/tottag-dashboard/issues
