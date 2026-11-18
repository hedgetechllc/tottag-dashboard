// Package protocol is Chrome's native messaging framing and the messages this helper speaks.
//
// Each message is a 32-bit length in native byte order followed by that many bytes of UTF-8
// JSON. Chrome caps host-to-extension messages at 1 MB; nothing here comes near it, because the
// helper passes on one Bluetooth value or notification at a time.
//
// stdout is the wire. Anything else written to it desynchronizes the framing, so every
// diagnostic goes to stderr, which Chrome captures into its own log.
package protocol

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"unsafe"
)

// MaxMessageBytes is Chrome's limit on a single host-to-extension message.
const MaxMessageBytes = 1024 * 1024

// maxIncomingBytes guards against a desynchronized stream: nothing legitimate is this large,
// and a length this wrong means continuing would allocate against garbage.
const maxIncomingBytes = 4 * MaxMessageBytes

var nativeOrder binary.ByteOrder = func() binary.ByteOrder {
	probe := uint16(1)
	if *(*byte)(unsafe.Pointer(&probe)) == 1 {
		return binary.LittleEndian
	}
	return binary.BigEndian
}()

// ErrTooLarge is returned when a message would exceed Chrome's limit.
var ErrTooLarge = errors.New("message exceeds the 1 MB native messaging limit")

// Encode frames one message.
func Encode(value any) ([]byte, error) {
	body, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	if len(body) > MaxMessageBytes {
		return nil, ErrTooLarge
	}
	frame := make([]byte, 4+len(body))
	nativeOrder.PutUint32(frame, uint32(len(body)))
	copy(frame[4:], body)
	return frame, nil
}

// Read reads one framed message, returning io.EOF when the extension closes the port.
func Read(r io.Reader) (json.RawMessage, error) {
	var header [4]byte
	if _, err := io.ReadFull(r, header[:]); err != nil {
		return nil, err
	}
	length := nativeOrder.Uint32(header[:])
	if length > maxIncomingBytes {
		return nil, fmt.Errorf("refusing a %d-byte message: the stream is not framed correctly", length)
	}
	body := make([]byte, length)
	if _, err := io.ReadFull(r, body); err != nil {
		return nil, err
	}
	return json.RawMessage(body), nil
}

// Request is every field any operation accepts. Operations read only their own.
type Request struct {
	ID string `json:"id"`
	Op string `json:"op"`
	// NamePrefix limits a scan to devices whose advertised name starts with it.
	NamePrefix string `json:"namePrefix,omitempty"`
	// Device is a device's ID, as a scan reported it.
	Device string `json:"device,omitempty"`
	// Services are the services a connection discovers, as UUIDs; the rest are never looked for.
	Services []string `json:"services,omitempty"`
	// Connection is a connection's ID, as connect returned it.
	Connection     string `json:"connection,omitempty"`
	Service        string `json:"service,omitempty"`
	Characteristic string `json:"characteristic,omitempty"`
	// Data is the bytes to write, base64 in the JSON.
	Data []byte `json:"data,omitempty"`
	// WithResponse asks for a write the device acknowledges.
	WithResponse bool `json:"withResponse,omitempty"`
	// On turns notifications on, or with false off.
	On bool `json:"on,omitempty"`
	// Port is a USB serial port's name, as usbList reported it.
	Port string `json:"port,omitempty"`
	// VendorID and ProductID limit usbList to one kind of USB device; zero lists every USB serial port.
	VendorID  int `json:"vendorId,omitempty"`
	ProductID int `json:"productId,omitempty"`
}

// Coded is an error the page is told about by name as well as in words, so it can act on what went
// wrong rather than only show it.
type Coded struct {
	Code    string
	Message string
}

func (e *Coded) Error() string { return e.Message }

// Errorf makes a Coded error.
func Errorf(code, format string, args ...any) error {
	return &Coded{Code: code, Message: fmt.Sprintf(format, args...)}
}

// Failure is the reply to anything that did not succeed.
type Failure struct {
	ID    string `json:"id"`
	OK    bool   `json:"ok"`
	Error string `json:"error"`
	Code  string `json:"code"`
}
