package video

import (
	"os"
	"strings"
	"testing"
	"time"
)

// createFileOfSize makes a sparse file of exactly size bytes without writing
// its content — the size check happens (and must fail) before Inspect ever
// tries to decode the file, so its content is irrelevant.
func createFileOfSize(path string, size int64) (*os.File, error) {
	f, err := os.Create(path)
	if err != nil {
		return nil, err
	}
	if err := f.Truncate(size); err != nil {
		f.Close()
		return nil, err
	}
	return f, nil
}

// Fixtures live in the worker's test suite; opened via a repo-relative path
// rather than duplicated into this package's testdata.
const (
	fixtureH264AAC    = "../../../worker/test/fixtures/video-h264-aac.mp4"
	fixtureH264Silent = "../../../worker/test/fixtures/video-h264-silent.mp4"
	fixtureVP9        = "../../../worker/test/fixtures/video-vp9.mp4"
)

func TestInspectAcceptsH264AAC(t *testing.T) {
	meta, err := Inspect(fixtureH264AAC)
	if err != nil {
		t.Fatalf("Inspect(%s) = %v, want no error", fixtureH264AAC, err)
	}
	if meta.VideoCodec != "h264" {
		t.Errorf("VideoCodec = %q, want h264", meta.VideoCodec)
	}
	if meta.AudioCodec != "aac" {
		t.Errorf("AudioCodec = %q, want aac", meta.AudioCodec)
	}
	if meta.Width <= 0 || meta.Height <= 0 {
		t.Errorf("dimensions = %dx%d, want positive", meta.Width, meta.Height)
	}
	if meta.Duration <= 0 {
		t.Errorf("Duration = %v, want positive", meta.Duration)
	}
	if meta.Size <= 0 {
		t.Errorf("Size = %d, want positive", meta.Size)
	}
}

func TestInspectAcceptsSilentH264(t *testing.T) {
	meta, err := Inspect(fixtureH264Silent)
	if err != nil {
		t.Fatalf("Inspect(%s) = %v, want no error", fixtureH264Silent, err)
	}
	if meta.VideoCodec != "h264" {
		t.Errorf("VideoCodec = %q, want h264", meta.VideoCodec)
	}
	if meta.AudioCodec != "" {
		t.Errorf("AudioCodec = %q, want empty (no audio track)", meta.AudioCodec)
	}
}

func TestInspectRejectsVP9(t *testing.T) {
	_, err := Inspect(fixtureVP9)
	if err == nil {
		t.Fatal("Inspect(vp9) = nil error, want rejection")
	}
	if !strings.Contains(err.Error(), "vp") && !strings.Contains(err.Error(), "unsupported video codec") {
		t.Errorf("error = %q, want it to name the unsupported video codec", err.Error())
	}
}

func TestInspectRejectsOversizeFile(t *testing.T) {
	dir := t.TempDir()
	path := dir + "/huge.mp4"
	f, err := createFileOfSize(path, MaxBytes+1)
	if err != nil {
		t.Fatalf("createFileOfSize: %v", err)
	}
	defer f.Close()

	_, err = Inspect(path)
	if err == nil {
		t.Fatal("Inspect(oversize) = nil error, want rejection")
	}
	if !strings.Contains(err.Error(), "size limit") {
		t.Errorf("error = %q, want it to name the size limit", err.Error())
	}
}

func TestValidateDurationRejectsOverTenMinutes(t *testing.T) {
	err := validateDuration(11 * time.Minute)
	if err == nil {
		t.Fatal("validateDuration(11m) = nil error, want rejection")
	}
	if !strings.Contains(err.Error(), "duration") {
		t.Errorf("error = %q, want it to name duration", err.Error())
	}
}

func TestValidateDurationAcceptsWithinLimit(t *testing.T) {
	if err := validateDuration(9 * time.Minute); err != nil {
		t.Errorf("validateDuration(9m) = %v, want no error", err)
	}
}
