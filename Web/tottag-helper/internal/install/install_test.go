package install

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestTheManifestAllowsThePublishedExtensionByDefault(t *testing.T) {
	manifest := manifestFor(Options{Executable: "/opt/tottag-helper"})
	if manifest.Name != HostName || manifest.Type != "stdio" || manifest.Path != "/opt/tottag-helper" {
		t.Fatalf("got %+v", manifest)
	}
	if len(manifest.AllowedOrigins) != 1 || manifest.AllowedOrigins[0] != "chrome-extension://"+ExtensionID+"/" {
		t.Fatalf("allowed %v", manifest.AllowedOrigins)
	}
}

func TestTheManifestCanAllowAnotherExtensionForDevelopment(t *testing.T) {
	manifest := manifestFor(Options{Executable: "/opt/tottag-helper", ExtensionIDs: []string{"abc", "def"}})
	want := []string{"chrome-extension://abc/", "chrome-extension://def/"}
	if strings.Join(manifest.AllowedOrigins, " ") != strings.Join(want, " ") {
		t.Fatalf("allowed %v, want %v", manifest.AllowedOrigins, want)
	}
}

func TestAGoodRegistrationHasNoProblems(t *testing.T) {
	exe := filepath.Join(t.TempDir(), "tottag-helper")
	if err := os.WriteFile(exe, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if problems := check(manifestFor(Options{Executable: exe})); len(problems) != 0 {
		t.Fatalf("problems: %v", problems)
	}
}

func TestEachWayARegistrationCanBeWrongIsReported(t *testing.T) {
	manifest := Manifest{Name: "something.else", Type: "pipe", Path: "relative/tottag-helper",
		AllowedOrigins: []string{"chrome-extension://another/"}}
	problems := strings.Join(check(manifest), "; ")
	for _, want := range []string{"names something.else", `type is not "stdio"`, "path is not absolute", "does not allow"} {
		if !strings.Contains(problems, want) {
			t.Errorf("%q does not mention %q", problems, want)
		}
	}
	manifest = manifestFor(Options{Executable: filepath.Join(t.TempDir(), "missing")})
	if problems := strings.Join(check(manifest), "; "); !strings.Contains(problems, "does not exist") {
		t.Errorf("a missing executable was not reported: %q", problems)
	}
}
