# Code signing policy

Free code signing provided by [SignPath.io](https://about.signpath.io), certificate by
[SignPath Foundation](https://signpath.org). This covers the TotTag Helper's Windows installer and
the executables in it; its macOS installer and app are signed with the project's Apple Developer ID
and notarized by Apple.

Team roles:

- Committers and reviewers: [Will Hedgecock](https://github.com/hedgecrw)
- Approvers: [Will Hedgecock](https://github.com/hedgecrw)

Every release is built from this repository by the
[release workflow](../../.github/workflows/tottag-helper-release.yml) on GitHub-hosted runners, and
every signing request is approved by hand in SignPath.

Privacy: this program will not transfer any information to other networked systems unless
specifically requested by the user or the person installing or operating it. It has no network
code at all: it talks only to the browser that starts it, through the TotTag Helper extension, and
to TotTags, over Bluetooth and USB on this computer.
