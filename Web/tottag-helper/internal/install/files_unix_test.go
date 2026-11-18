//go:build darwin || linux

package install

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestAManifestIsWrittenReadBackAndRemovedWhereTheBrowserLooks(t *testing.T) {
	location := Location{Browser: "Chrome", Dir: filepath.Join(t.TempDir(), "NativeMessagingHosts")}
	raw, _ := json.Marshal(manifestFor(Options{Executable: "/opt/tottag-helper"}))

	path, err := writeManifest(location, raw)
	if err != nil {
		t.Fatal(err)
	}
	if want := filepath.Join(location.Dir, "net.tottag.helper.json"); path != want {
		t.Fatalf("wrote %s, want %s", path, want)
	}
	_, read, err := readManifest(location)
	if err != nil {
		t.Fatal(err)
	}
	var manifest Manifest
	if err := json.Unmarshal(read, &manifest); err != nil || manifest.Path != "/opt/tottag-helper" {
		t.Fatalf("read back %s (%v)", read, err)
	}
	if err := removeManifest(location); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("the manifest is still there: %v", err)
	}
}
