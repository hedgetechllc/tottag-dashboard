package usb

// Stand-in ports throughout: nothing here needs a tag plugged in.

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"sync"
	"testing"
	"time"

	"github.com/hedgetechllc/tottag-dashboard/tottag-helper/internal/protocol"
)

// fakePort is a port whose incoming bytes the test writes into `tag`.
type fakePort struct {
	incoming *io.PipeReader
	tag      *io.PipeWriter

	mu      sync.Mutex
	written bytes.Buffer
	closed  bool
}

func newFakePort() *fakePort {
	incoming, tag := io.Pipe()
	return &fakePort{incoming: incoming, tag: tag}
}

func (f *fakePort) Read(p []byte) (int, error) { return f.incoming.Read(p) }

func (f *fakePort) Write(p []byte) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.closed {
		return 0, io.ErrClosedPipe
	}
	return f.written.Write(p)
}

func (f *fakePort) Close() error {
	f.mu.Lock()
	f.closed = true
	f.mu.Unlock()
	return f.incoming.CloseWithError(io.ErrClosedPipe)
}

func (f *fakePort) isClosed() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.closed
}

// recorder keeps every event, in the order they were sent.
type recorder struct {
	mu     sync.Mutex
	events []map[string]any
}

func (r *recorder) send(message any) {
	// As the page would see it: through JSON, which also turns the []byte into base64
	raw, _ := json.Marshal(message)
	var event map[string]any
	_ = json.Unmarshal(raw, &event)
	r.mu.Lock()
	r.events = append(r.events, event)
	r.mu.Unlock()
}

func (r *recorder) snapshot() []map[string]any {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]map[string]any(nil), r.events...)
}

// waitFor waits until an event satisfies done, and returns everything sent until then.
func (r *recorder) waitFor(t *testing.T, done func(map[string]any) bool) []map[string]any {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		events := r.snapshot()
		for _, event := range events {
			if done(event) {
				return events
			}
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("gave up waiting; sent %v", r.snapshot())
	return nil
}

func received(t *testing.T, events []map[string]any, connection string) []byte {
	t.Helper()
	var all []byte
	for _, event := range events {
		if event["event"] != "usbData" || event["connection"] != connection {
			continue
		}
		var chunk []byte
		raw, _ := json.Marshal(event["data"])
		if err := json.Unmarshal(raw, &chunk); err != nil {
			t.Fatal(err)
		}
		all = append(all, chunk...)
	}
	return all
}

func openOne(t *testing.T) (*Ports, *recorder, *fakePort, string) {
	t.Helper()
	r := &recorder{}
	port := newFakePort()
	p := NewWith(r.send, nil, func(name string) (Port, error) {
		if name != "/dev/cu.usbmodem1101" {
			t.Fatalf("opened %q", name)
		}
		return port, nil
	})
	reply, err := p.Handle(protocol.Request{Op: "usbOpen", Port: "/dev/cu.usbmodem1101"})
	if err != nil {
		t.Fatal(err)
	}
	return p, r, port, reply["connection"].(string)
}

func TestOnlyTheKindOfDeviceAskedForIsListed(t *testing.T) {
	p := NewWith(nil, func() ([]Listed, error) {
		return []Listed{
			{Port: "/dev/cu.usbmodem2101", VendorID: 0x1209, ProductID: 0x2828},
			{Port: "/dev/cu.usbserial-0001", VendorID: 0x10c4, ProductID: 0xea60},
			{Port: "/dev/cu.usbmodem1101", VendorID: 0x1209, ProductID: 0x2828},
		}, nil
	}, nil)
	reply, err := p.Handle(protocol.Request{Op: "usbList", VendorID: 0x1209, ProductID: 0x2828})
	if err != nil {
		t.Fatal(err)
	}
	ports := reply["ports"].([]Listed)
	if len(ports) != 2 || ports[0].Port != "/dev/cu.usbmodem1101" || ports[1].Port != "/dev/cu.usbmodem2101" {
		t.Fatalf("got %v", ports)
	}
	reply, _ = p.Handle(protocol.Request{Op: "usbList"})
	if len(reply["ports"].([]Listed)) != 3 {
		t.Fatalf("with no IDs, got %v", reply["ports"])
	}
}

func TestAPortThatCannotBeListedSaysWhy(t *testing.T) {
	p := NewWith(nil, func() ([]Listed, error) { return nil, errors.New("no IOKit") }, nil)
	_, err := p.Handle(protocol.Request{Op: "usbList"})
	var coded *protocol.Coded
	if !errors.As(err, &coded) || coded.Code != "usb-unavailable" {
		t.Fatalf("got %v", err)
	}
}

func TestWhatThePageWritesReachesThePort(t *testing.T) {
	p, _, port, id := openOne(t)
	defer p.Close()
	if _, err := p.Handle(protocol.Request{Op: "usbWrite", Connection: id, Data: []byte{0x07, 1, 2, 3, 4}}); err != nil {
		t.Fatal(err)
	}
	port.mu.Lock()
	defer port.mu.Unlock()
	if !bytes.Equal(port.written.Bytes(), []byte{0x07, 1, 2, 3, 4}) {
		t.Fatalf("wrote %v", port.written.Bytes())
	}
}

func TestEverythingThatArrivesIsPassedOnInOrderBeforeTheUnplugging(t *testing.T) {
	p, r, port, id := openOne(t)
	go func() {
		_, _ = port.tag.Write([]byte("TotTag "))
		_, _ = port.tag.Write([]byte("02:31\n"))
		port.tag.CloseWithError(io.EOF)
	}()
	events := r.waitFor(t, func(event map[string]any) bool { return event["event"] == "usbClosed" })
	if got := string(received(t, events, id)); got != "TotTag 02:31\n" {
		t.Fatalf("received %q", got)
	}
	last := events[len(events)-1]
	if last["event"] != "usbClosed" || last["connection"] != id || last["error"] != "The tag was unplugged." {
		t.Fatalf("ended with %v", last)
	}
	if !port.isClosed() {
		t.Fatal("the port was left open")
	}
	if _, err := p.Handle(protocol.Request{Op: "usbWrite", Connection: id, Data: []byte{1}}); err == nil {
		t.Fatal("wrote to a port that had gone")
	}
}

func TestALargeTransferIsSplitIntoMessagesChromeAccepts(t *testing.T) {
	p, r, port, id := openOne(t)
	defer p.Close()
	sent := make([]byte, 3*maxChunkBytes+12345)
	for i := range sent {
		sent[i] = byte(i * 7)
	}
	go func() {
		_, _ = port.tag.Write(sent)
		port.tag.CloseWithError(io.EOF)
	}()
	events := r.waitFor(t, func(event map[string]any) bool { return event["event"] == "usbClosed" })
	if got := received(t, events, id); !bytes.Equal(got, sent) {
		t.Fatalf("received %d bytes, not the %d sent, or not the same ones", len(got), len(sent))
	}
	for _, event := range events {
		frame, err := protocol.Encode(event)
		if err != nil || len(frame) > protocol.MaxMessageBytes {
			t.Fatalf("a %d-byte message: %v", len(frame), err)
		}
	}
}

func TestClosingAPortFromThePageNeedsNoReply(t *testing.T) {
	p, r, port, id := openOne(t)
	if _, err := p.Handle(protocol.Request{Op: "usbClose", Connection: id}); err != nil {
		t.Fatal(err)
	}
	if !port.isClosed() {
		t.Fatal("the port was left open")
	}
	time.Sleep(50 * time.Millisecond)
	for _, event := range r.snapshot() {
		if event["event"] == "usbClosed" {
			t.Fatalf("told the page what it already knew: %v", event)
		}
	}
}

func TestThePageGoingClosesEveryPort(t *testing.T) {
	p, _, port, _ := openOne(t)
	p.Close()
	if !port.isClosed() {
		t.Fatal("the port was left open")
	}
}

func TestAPortThatWouldNotOpenSaysWhy(t *testing.T) {
	p := NewWith(nil, nil, func(string) (Port, error) {
		return nil, protocol.Errorf("port-busy", "Another program is using that USB port.")
	})
	_, err := p.Handle(protocol.Request{Op: "usbOpen", Port: "/dev/cu.usbmodem1101"})
	var coded *protocol.Coded
	if !errors.As(err, &coded) || coded.Code != "port-busy" {
		t.Fatalf("got %v", err)
	}
	p = NewWith(nil, nil, func(string) (Port, error) { return nil, errors.New("strange") })
	if _, err = p.Handle(protocol.Request{Op: "usbOpen", Port: "/dev/cu.usbmodem1101"}); !errors.As(err, &coded) || coded.Code != "open-failed" {
		t.Fatalf("got %v", err)
	}
}

func TestNothingCanBeWrittenToAPortThatIsNotOpen(t *testing.T) {
	p := NewWith(nil, nil, nil)
	_, err := p.Handle(protocol.Request{Op: "usbWrite", Connection: "u9", Data: []byte{1}})
	var coded *protocol.Coded
	if !errors.As(err, &coded) || coded.Code != "not-connected" {
		t.Fatalf("got %v", err)
	}
	if _, err := p.Handle(protocol.Request{Op: "usbClose", Connection: "u9"}); err != nil {
		t.Fatalf("closing what was not open: %v", err)
	}
}

func TestAPortThatIsNotThereIsNamedAsGone(t *testing.T) {
	_, err := openSystemPort("/dev/cu.tottag-test-no-such-port")
	var coded *protocol.Coded
	if !errors.As(err, &coded) || coded.Code != "no-port" {
		t.Fatalf("got %v", err)
	}
}
