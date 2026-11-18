package main

// The helper as a browser runs it: built, started with the extension's origin as its argument,
// and spoken to in framed JSON on stdin until stdin closes. Only requests that need no Bluetooth,
// so this runs anywhere without a permission prompt.

import (
	"bytes"
	"encoding/json"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/hedgetechllc/tottag-dashboard/tottag-helper/internal/install"
	"github.com/hedgetechllc/tottag-dashboard/tottag-helper/internal/protocol"
)

func build(t *testing.T) string {
	t.Helper()
	exe := filepath.Join(t.TempDir(), "tottag-helper")
	if runtime.GOOS == "windows" {
		exe += ".exe"
	}
	out, err := exec.Command("go", "build", "-ldflags", "-X main.version=9.8.7-test", "-o", exe, ".").CombinedOutput()
	if err != nil {
		t.Fatalf("build: %v\n%s", err, out)
	}
	return exe
}

func TestItSaysWhichVersionItIs(t *testing.T) {
	out, err := exec.Command(build(t), "version").Output()
	if err != nil || strings.TrimSpace(string(out)) != "9.8.7-test" {
		t.Fatalf("got %q (%v)", out, err)
	}
}

func TestItAnswersEachRequestAsABrowserSendsThemAndExitsWhenStdinCloses(t *testing.T) {
	var stdin bytes.Buffer
	for _, request := range []map[string]string{{"id": "r1", "op": "identify"}, {"id": "r2", "op": "nonsense"}} {
		frame, _ := protocol.Encode(request)
		stdin.Write(frame)
	}
	cmd := exec.Command(build(t), "chrome-extension://"+install.ExtensionID+"/")
	cmd.Stdin = &stdin
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("exited with %v\n%s", err, stderr.String())
		}
	case <-time.After(20 * time.Second):
		_ = cmd.Process.Kill()
		t.Fatal("it did not exit once stdin closed")
	}

	// Requests are answered as they arrive, so the replies may come in either order
	replies := map[string]map[string]any{}
	for {
		raw, err := protocol.Read(&stdout)
		if err != nil {
			break
		}
		var reply map[string]any
		if err := json.Unmarshal(raw, &reply); err != nil {
			t.Fatal(err)
		}
		replies[reply["id"].(string)] = reply
	}
	if r := replies["r1"]; r["ok"] != true || r["version"] != "9.8.7-test" {
		t.Errorf("identify: %v", r)
	}
	if r := replies["r2"]; r["ok"] != false || r["code"] != "unknown-op" {
		t.Errorf("an unknown request: %v", r)
	}
	if !strings.Contains(stderr.String(), "ready") {
		t.Errorf("nothing on stderr to say it started: %q", stderr.String())
	}
}
