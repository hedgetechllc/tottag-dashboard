; The Windows installer: per-user, so it needs no administrator rights to install, and the
; helper registers itself under HKCU, which needs none either.
;
;   iscc /DVersion=0.2.0 /DSource=..\..\dist\windows packaging\windows\tottag-helper.iss
;
; It registers the helper with each Chromium browser through the helper's own `install`
; command, the same code the macOS package runs, and removes the registrations through
; `uninstall`.

#ifndef Version
  #define Version "0.0.0"
#endif
#ifndef NumericVersion
  #define NumericVersion "0.0.0"
#endif
#ifndef Source
  #define Source "..\..\dist\windows"
#endif

[Setup]
AppId={{66822D95-7F54-409F-96C2-5E8CDFEB9A80}
AppName=TotTag Helper
AppVersion={#Version}
AppPublisher=HedgeTech LLC
AppPublisherURL=https://github.com/hedgetechllc/tottag-dashboard
AppSupportURL=https://github.com/hedgetechllc/tottag-dashboard/issues
DefaultDirName={localappdata}\Programs\TotTag Helper
DisableDirPage=yes
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible arm64
ArchitecturesInstallIn64BitMode=x64compatible arm64
OutputDir={#Source}\..
OutputBaseFilename=TotTag-Helper-Windows
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName=TotTag Helper
MinVersion=10.0
; Product name and version on the installer itself, which SignPath requires of anything it signs.
VersionInfoVersion={#NumericVersion}
VersionInfoProductName=TotTag Helper
VersionInfoProductVersion={#NumericVersion}
VersionInfoDescription=TotTag Helper installer
VersionInfoCopyright=Copyright (c) 2026 HedgeTech LLC. MIT License.

[Files]
Source: "{#Source}\tottag-helper-amd64.exe"; DestDir: "{app}"; DestName: "tottag-helper.exe"; Check: not IsArm64; Flags: ignoreversion
Source: "{#Source}\tottag-helper-arm64.exe"; DestDir: "{app}"; DestName: "tottag-helper.exe"; Check: IsArm64; Flags: ignoreversion

[Run]
Filename: "{app}\tottag-helper.exe"; Parameters: "install"; Flags: runhidden waituntilterminated; StatusMsg: "Registering with your browsers…"

[UninstallRun]
Filename: "{app}\tottag-helper.exe"; Parameters: "uninstall"; Flags: runhidden waituntilterminated; RunOnceId: "Unregister"

[UninstallDelete]
Type: files; Name: "{app}\net.tottag.helper.json"

[Messages]
FinishedLabel=The TotTag Helper is installed. Reload the TotTag dashboard; it should show the helper as connected. You also need the TotTag Helper browser extension.
