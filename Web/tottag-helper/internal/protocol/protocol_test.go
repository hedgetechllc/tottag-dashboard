package protocol

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"testing"
)

func TestAMessageSurvivesTheRoundTrip(t *testing.T) {
	frame, err := Encode(map[string]any{"id": "r1", "op": "read", "data": []byte{0, 1, 254, 255}})
	if err != nil {
		t.Fatal(err)
	}
	raw, err := Read(bytes.NewReader(frame))
	if err != nil {
		t.Fatal(err)
	}
	var request Request
	if err := json.Unmarshal(raw, &request); err != nil {
		t.Fatal(err)
	}
	if request.ID != "r1" || request.Op != "read" || !bytes.Equal(request.Data, []byte{0, 1, 254, 255}) {
		t.Fatalf("got %+v", request)
	}
}

func TestTheLengthIsInNativeByteOrder(t *testing.T) {
	frame, _ := Encode("x")
	// Every platform the helper ships for is little-endian
	if want := []byte{3, 0, 0, 0, '"', 'x', '"'}; !bytes.Equal(frame, want) {
		t.Fatalf("frame %v, want %v", frame, want)
	}
}

func TestMessagesFollowOneAnotherOnTheStream(t *testing.T) {
	var stream bytes.Buffer
	for _, op := range []string{"hello", "scanStart", "scanStop"} {
		frame, _ := Encode(Request{ID: op, Op: op})
		stream.Write(frame)
	}
	for _, want := range []string{"hello", "scanStart", "scanStop"} {
		raw, err := Read(&stream)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(raw), `"op":"`+want+`"`) {
			t.Fatalf("got %s, want op %s", raw, want)
		}
	}
	if _, err := Read(&stream); !errors.Is(err, io.EOF) {
		t.Fatalf("after the last message, got %v, want io.EOF", err)
	}
}

func TestAMessageOverChromesLimitIsRefused(t *testing.T) {
	if _, err := Encode(strings.Repeat("x", MaxMessageBytes)); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("got %v, want ErrTooLarge", err)
	}
}

func TestALengthThatCannotBeRightIsRefusedRatherThanAllocated(t *testing.T) {
	header := []byte{0xff, 0xff, 0xff, 0x7f}
	if _, err := Read(bytes.NewReader(header)); err == nil || !strings.Contains(err.Error(), "not framed correctly") {
		t.Fatalf("got %v", err)
	}
}

func TestAMessageCutShortIsAnError(t *testing.T) {
	frame, _ := Encode(map[string]string{"op": "hello"})
	if _, err := Read(bytes.NewReader(frame[:len(frame)-2])); !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Fatalf("got %v, want io.ErrUnexpectedEOF", err)
	}
}
