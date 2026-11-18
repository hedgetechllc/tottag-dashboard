#!/bin/sh
# Sets up the credentials that sign and notarize the TotTag Helper, on this Mac and for the
# GitHub release workflow. Run it yourself, in Terminal, from Web/tottag-helper:
#
#   packaging/setup-signing.sh            check what is in place, and set up what is missing
#
# It checks before it changes anything, and asks before each change.
#
# The Apple Developer team and the SignPath organization are the ones A3EM's card helper
# already uses; only the GitHub side (and a SignPath project for this repository) is new.
#
# Where each credential goes, and nowhere else:
#   - Signing identities stay in your login keychain, where Xcode puts them.
#   - Notarization credentials — an App Store Connect team API key, or an Apple ID and
#     app-specific password — go into your login keychain as a notarytool profile
#     ("tottag-notary"; A3EM's "a3em-notary" is the same team and is used if it is there),
#     which notarytool itself stores.
#   - For CI, copies go into GitHub encrypted secrets on an environment named
#     "tottag-helper-release", which only tottag-helper-v* tags may deploy to — so a workflow on
#     an arbitrary branch or pull request can never read them.
# Nothing typed here is echoed, logged, or written to a file.
set -eu
TEAM=D3TVN67UY9
PROFILE=tottag-notary
REPO=hedgetechllc/tottag-dashboard
ENVIRONMENT=tottag-helper-release

bold() { printf '\n\033[1m%s\033[0m\n' "$1"; }
ask() { printf '%s [y/N] ' "$1"; read -r reply; [ "$reply" = y ] || [ "$reply" = Y ]; }
# IFS= keeps leading and trailing spaces, which are legal in a password.
secret() { printf '%s: ' "$1" >&2; stty -echo; IFS= read -r value; stty echo; printf '\n' >&2; printf '%s' "$value"; }
has_identity() { security find-identity -v -p basic | grep -q "\"$1: .*($TEAM)\""; }
has_profile() { xcrun notarytool history --keychain-profile "$1" >/dev/null 2>&1; }

bold "1. Signing identities (team $TEAM)"
if has_identity "Developer ID Application"; then echo "   Developer ID Application: present"; else
  echo "   Developer ID Application: MISSING"; fi
if has_identity "Developer ID Installer"; then echo "   Developer ID Installer:   present"; else
  cat <<'TEXT'
   Developer ID Installer:   MISSING. It signs the .pkg. To create it:
     Xcode > Settings > Accounts > select the team > Manage Certificates… > + > Developer ID Installer
   (Only the team's Account Holder can create Developer ID certificates.) Then run this again.
TEXT
fi

bold "2. Notarization on this Mac"
# An App Store Connect team API key with the Developer role is the simpler credential: no
# password, no two-factor prompts. Personal (individual) keys cannot notarize.
api_key() {
  printf '   Path to the team API key (.p8): '; read -r P8
  [ -f "$P8" ] || { echo "   No file at $P8"; exit 1; }
  KEY_ID=$(basename "$P8" .p8 | sed 's/.*_//')
  printf '   Key ID [%s]: ' "$KEY_ID"; read -r reply; KEY_ID=${reply:-$KEY_ID}
  cat <<'TEXT'
   Issuer ID: App Store Connect > Users and Access > Integrations > App Store Connect API >
   Team Keys. It is shown above the list of keys.
TEXT
  printf '   Issuer ID: '; read -r ISSUER
}
if has_profile "$PROFILE"; then
  echo "   Keychain profile $PROFILE: present"
elif has_profile a3em-notary; then
  PROFILE=a3em-notary
  echo "   Keychain profile a3em-notary (A3EM's, the same team): present, and good for this too"
elif ask "   No $PROFILE profile. Create one now?"; then
  if ask "   Use an App Store Connect team API key (recommended)?"; then
    api_key
    xcrun notarytool store-credentials "$PROFILE" --key "$P8" --key-id "$KEY_ID" --issuer "$ISSUER"
  else
    cat <<'TEXT'
   notarytool needs your Apple ID and an app-specific password for it. Make the password at
   https://account.apple.com > Sign-In and Security > App-Specific Passwords. notarytool asks
   for it itself and stores it in your keychain.
TEXT
    printf '   Apple ID: '; read -r APPLE_ID
    xcrun notarytool store-credentials "$PROFILE" --apple-id "$APPLE_ID" --team-id "$TEAM"
  fi
fi
echo "   Local release builds: NOTARY_KEYCHAIN_PROFILE=$PROFILE packaging/macos/build-pkg.sh <version>"

bold "3. GitHub release workflow"
if ! gh auth status >/dev/null 2>&1; then echo "   gh is not signed in; run gh auth login first."; exit 0; fi
if ! ask "   Store signing credentials for $REPO's release workflow?"; then exit 0; fi

# An environment whose secrets only tottag-helper-v* tags can reach.
gh api -X PUT "repos/$REPO/environments/$ENVIRONMENT" --input - >/dev/null <<'JSON'
{"deployment_branch_policy": {"protected_branches": false, "custom_branch_policies": true}}
JSON
gh api "repos/$REPO/environments/$ENVIRONMENT/deployment-branch-policies" --jq '.branch_policies[].name' 2>/dev/null |
  grep -qx 'tottag-helper-v\*' ||
  gh api -X POST "repos/$REPO/environments/$ENVIRONMENT/deployment-branch-policies" -f name='tottag-helper-v*' -f type=tag >/dev/null
echo "   Environment $ENVIRONMENT: deployable only from tottag-helper-v* tags"
gh variable set APPLE_TEAM_ID --repo "$REPO" --body "$TEAM"

if ask "   macOS: upload the two Developer ID identities?"; then
  cat <<'TEXT'
   Export them from Keychain Access: select "Developer ID Application: …" and
   "Developer ID Installer: …" together (My Certificates), File > Export Items…, save as .p12
   with a password. Export only those two — anything else in the file reaches CI too. (The
   .p12 made for A3EM's card helper is the same pair, if you still have it.)
TEXT
  printf '   Path to the .p12: '; IFS= read -r P12
  [ -f "$P12" ] || { echo "   No file at $P12"; exit 1; }
  P12_PASSWORD=$(secret "   Its password")
  # Keychain Access encrypts the certificates with 40-bit RC2, which OpenSSL 3 (Homebrew's)
  # reads only with -legacy and LibreSSL (macOS's own) reads without it. Try both.
  if ! CERTS=$(openssl pkcs12 -in "$P12" -nokeys -passin "pass:$P12_PASSWORD" 2>"$TMPDIR/p12.err") &&
     ! CERTS=$(openssl pkcs12 -legacy -in "$P12" -nokeys -passin "pass:$P12_PASSWORD" 2>"$TMPDIR/p12.err"); then
    echo "   openssl could not read $P12:"
    sed 's/^/     /' "$TMPDIR/p12.err" | head -5
    rm -f "$TMPDIR/p12.err"
    exit 1
  fi
  rm -f "$TMPDIR/p12.err"
  for NAME in "Developer ID Application" "Developer ID Installer"; do
    if ! printf '%s\n' "$CERTS" | grep -q "subject=.*$NAME: .*($TEAM)"; then
      echo "   $P12 has no $NAME certificate for team $TEAM. Export both identities together."
      exit 1
    fi
  done
  unset CERTS
  base64 -i "$P12" | gh secret set MACOS_CERTS_P12 --repo "$REPO" --env "$ENVIRONMENT"
  printf '%s' "$P12_PASSWORD" | gh secret set MACOS_CERTS_PASSWORD --repo "$REPO" --env "$ENVIRONMENT"
  echo "   Stored. You can delete $P12 now."
fi

if ask "   macOS: store notarization credentials?"; then
  if ask "   Use an App Store Connect team API key (recommended)?"; then
    [ -n "${P8:-}" ] || api_key
    gh secret set APPLE_API_KEY_P8 --repo "$REPO" --env "$ENVIRONMENT" < "$P8"
    printf '%s' "$KEY_ID" | gh secret set APPLE_API_KEY_ID --repo "$REPO" --env "$ENVIRONMENT"
    printf '%s' "$ISSUER" | gh secret set APPLE_API_ISSUER --repo "$REPO" --env "$ENVIRONMENT"
  else
    printf '   Apple ID: '; read -r APPLE_ID
    printf '%s' "$APPLE_ID" | gh secret set APPLE_ID --repo "$REPO" --env "$ENVIRONMENT"
    secret "   App-specific password" | gh secret set APPLE_APP_PASSWORD --repo "$REPO" --env "$ENVIRONMENT"
  fi
  echo "   Stored."
fi

if ask "   Windows: store SignPath credentials (once this repository's SignPath project is set up)?"; then
  cat <<'TEXT'
   All from app.signpath.io. The organization ID is a GUID, shown in the organization's
   settings and in the address bar; it is the same organization as A3EM's. The project and
   signing-policy slugs are on this repository's project page (a project of its own, linked to
   this GitHub repository). The API token belongs to a CI user (a user of type CI, not a
   person) who is listed as a Submitter on the signing policy; A3EM's CI user will do, once it
   is added as a Submitter here.
TEXT
  printf '   Organization ID: '; read -r ORG
  printf '   Project slug [tottag-helper]: '; read -r PROJECT; PROJECT=${PROJECT:-tottag-helper}
  printf '   Signing policy slug [release-signing]: '; read -r POLICY; POLICY=${POLICY:-release-signing}
  gh variable set SIGNPATH_ORGANIZATION_ID --repo "$REPO" --body "$ORG"
  gh variable set SIGNPATH_PROJECT_SLUG --repo "$REPO" --body "$PROJECT"
  gh variable set SIGNPATH_POLICY_SLUG --repo "$REPO" --body "$POLICY"
  secret "   API token (a CI user's, with submitter rights on the policy)" |
    gh secret set SIGNPATH_API_TOKEN --repo "$REPO" --env "$ENVIRONMENT"
  echo "   Stored."
fi
bold "Done. Secrets in $ENVIRONMENT:"
gh secret list --repo "$REPO" --env "$ENVIRONMENT"
