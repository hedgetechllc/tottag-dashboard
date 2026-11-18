// Command tottag-helper is the TotTag dashboard's native helper for Bluetooth.
//
// Started by a browser, it is a native messaging host: length-prefixed JSON on stdin and
// stdout, one process for as long as the dashboard keeps its port to the extension open,
// exiting when the browser closes stdin. Started from a terminal it installs or checks itself.
//
//	tottag-helper install [--system] [--extension-id ID ...]
//	tottag-helper uninstall [--system]
//	tottag-helper doctor
//	tottag-helper version
package main

import (
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"sync"

	"github.com/hedgetechllc/tottag-dashboard/tottag-helper/internal/ble"
	"github.com/hedgetechllc/tottag-dashboard/tottag-helper/internal/install"
	"github.com/hedgetechllc/tottag-dashboard/tottag-helper/internal/protocol"
)

// version is set at build time with -ldflags "-X main.version=…". A plain `go build` says it is a dev build.
var version = "0.0.0-dev"

func main() {
	args := os.Args[1:]
	command := ""
	if len(args) > 0 {
		command = args[0]
	}
	var err error
	switch command {
	case "install", "uninstall":
		options := install.Options{}
		for i := 1; i < len(args); i++ {
			switch args[i] {
			case "--system":
				options.System = true
			case "--extension-id":
				if i+1 < len(args) {
					options.ExtensionIDs = append(options.ExtensionIDs, args[i+1])
					i++
				}
			case "--executable":
				if i+1 < len(args) {
					options.Executable = args[i+1]
					i++
				}
			default:
				err = fmt.Errorf("unknown option %s", args[i])
			}
		}
		if err != nil {
			break
		}
		if command == "install" {
			fmt.Println("Registering the TotTag Helper:")
			err = install.Install(os.Stdout, options)
		} else {
			err = install.Uninstall(os.Stdout, options.System)
		}
	case "doctor":
		fmt.Println("TotTag Helper", version)
		err = install.Doctor(os.Stdout)
		if err == nil {
			fmt.Println("Everything is in place.")
		}
	case "version", "--version":
		fmt.Println(version)
	case "help", "--help", "-h":
		fmt.Print(usage)
	default:
		// A browser passes the calling extension's origin, and on Windows a parent window handle
		if command == "" || strings.HasPrefix(command, "chrome-extension://") || strings.HasPrefix(command, "--parent-window") {
			err = host()
		} else {
			fmt.Fprint(os.Stderr, usage)
			os.Exit(2)
		}
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "tottag-helper:", err)
		os.Exit(1)
	}
}

const usage = `tottag-helper — the TotTag Helper, the TotTag dashboard's program for Bluetooth.

  install [--system] [--extension-id ID]   register with every Chromium browser found
  uninstall [--system]                     remove those registrations
  doctor                                   check the registrations and that the helper answers
  version                                  print the version

Browsers start it with no command; it is not meant to be run that way by hand.
`

// host is the native messaging loop.
func host() error {
	ignoreBrokenPipe()
	var mu sync.Mutex
	send := func(message any) {
		frame, err := protocol.Encode(message)
		if err != nil {
			fmt.Fprintln(os.Stderr, "tottag-helper: could not send:", err)
			return
		}
		mu.Lock()
		defer mu.Unlock()
		// A closed stdout means the page has gone
		os.Stdout.Write(frame)
	}
	session := ble.New(version, send)
	fmt.Fprintf(os.Stderr, "tottag-helper %s ready\n", version)
	var work sync.WaitGroup
	for {
		raw, err := protocol.Read(os.Stdin)
		if err != nil {
			// The browser closes stdin when the port closes: nobody is listening any more, so
			// stop scanning and let go of every tag
			session.Close()
			work.Wait()
			if errors.Is(err, io.EOF) {
				return nil
			}
			return err
		}
		work.Add(1)
		go func() {
			defer work.Done()
			send(session.Handle(raw))
		}()
	}
}
