// Package video performs local MP4 preflight for the CLI: the same checks
// the server enforces (H.264 video, optional AAC audio, size and duration
// caps), run against the file before it ever leaves the machine.
package video

import (
	"errors"
	"fmt"
	"os"
	"time"

	"github.com/Eyevinn/mp4ff/mp4"
)

// Metadata is the subset of MP4 properties the CLI needs before publishing:
// enough to preflight the server's own limits and to print a useful summary.
type Metadata struct {
	Size       int64
	Duration   time.Duration
	Width      int
	Height     int
	VideoCodec string
	AudioCodec string
}

const (
	// MaxBytes mirrors the worker's MAX_VIDEO_BYTES binding.
	MaxBytes int64 = 100_000_000
	// MaxDuration mirrors the worker's MAX_VIDEO_DURATION_SECONDS binding (600s).
	MaxDuration = 10 * time.Minute

	// aacObjectType is the ISO/IEC 14496-3 (MPEG-4 Audio) ObjectTypeIndication,
	// i.e. what makes an mp4a stream's codec string "mp4a.40.*" — the same
	// prefix the server checks.
	aacObjectType = 0x40
)

// Inspect checks path's size before ever decoding it, then parses just the
// moov box (mdat is never buffered into memory) to confirm H.264 video,
// optional AAC audio, and the size/duration bounds the server enforces —
// so an obviously invalid upload fails fast, locally, with an actionable
// error naming the limit or codec it violated.
func Inspect(path string) (Metadata, error) {
	fi, err := os.Stat(path)
	if err != nil {
		return Metadata{}, err
	}
	if fi.IsDir() {
		return Metadata{}, fmt.Errorf("%s is a directory, not a video file", path)
	}
	size := fi.Size()
	if size <= 0 {
		return Metadata{}, fmt.Errorf("%s is empty", path)
	}
	if size > MaxBytes {
		return Metadata{}, fmt.Errorf("video exceeds the %d-byte size limit (got %d bytes)", MaxBytes, size)
	}

	f, err := os.Open(path)
	if err != nil {
		return Metadata{}, err
	}
	defer f.Close()

	// DecModeLazyMdat never reads the (potentially huge) sample data into
	// memory; only the moov box's metadata is decoded.
	mp4f, err := mp4.DecodeFile(f, mp4.WithDecodeMode(mp4.DecModeLazyMdat))
	if err != nil {
		return Metadata{}, fmt.Errorf("%s is not a valid mp4 file: %w", path, err)
	}
	if mp4f.Moov == nil {
		return Metadata{}, fmt.Errorf("%s has no moov box (metadata) — is this a valid, non-fragmented MP4?", path)
	}

	meta, err := metadataFromMoov(mp4f.Moov, size)
	if err != nil {
		return Metadata{}, err
	}
	if err := validateDuration(meta.Duration); err != nil {
		return Metadata{}, err
	}
	return meta, nil
}

// validateDuration is split out from Inspect so the over-the-limit case can
// be exercised directly against a constructed duration, without needing a
// real ten-minute-plus fixture file.
func validateDuration(d time.Duration) error {
	if d > MaxDuration {
		return fmt.Errorf("video duration %s exceeds the %s limit", d, MaxDuration)
	}
	return nil
}

func metadataFromMoov(moov *mp4.MoovBox, size int64) (Metadata, error) {
	var videoTrak, audioTrak *mp4.TrakBox
	var videoCount, audioCount int
	for _, trak := range moov.Traks {
		if trak.Mdia == nil || trak.Mdia.Hdlr == nil {
			continue
		}
		switch trak.Mdia.Hdlr.HandlerType {
		case "vide":
			videoCount++
			videoTrak = trak
		case "soun":
			audioCount++
			audioTrak = trak
		}
	}
	if videoCount != 1 {
		return Metadata{}, fmt.Errorf("expected exactly one video track, found %d", videoCount)
	}
	if audioCount > 1 {
		return Metadata{}, fmt.Errorf("expected at most one audio track, found %d", audioCount)
	}

	width, height, err := videoTrackInfo(videoTrak)
	if err != nil {
		return Metadata{}, err
	}

	var audioCodec string
	if audioTrak != nil {
		audioCodec, err = audioTrackInfo(audioTrak)
		if err != nil {
			return Metadata{}, err
		}
	}

	duration, err := movieDuration(moov)
	if err != nil {
		return Metadata{}, err
	}

	return Metadata{
		Size:       size,
		Duration:   duration,
		Width:      width,
		Height:     height,
		VideoCodec: "h264",
		AudioCodec: audioCodec,
	}, nil
}

func stsdOf(trak *mp4.TrakBox) (*mp4.StsdBox, error) {
	if trak.Mdia == nil || trak.Mdia.Minf == nil || trak.Mdia.Minf.Stbl == nil || trak.Mdia.Minf.Stbl.Stsd == nil {
		return nil, errors.New("track is missing a sample description (stsd) box")
	}
	return trak.Mdia.Minf.Stbl.Stsd, nil
}

// videoTrackInfo requires the H.264 (avc1/avc3) sample entry and returns its
// pixel dimensions; any other visual codec is rejected by name.
func videoTrackInfo(trak *mp4.TrakBox) (width, height int, err error) {
	stsd, err := stsdOf(trak)
	if err != nil {
		return 0, 0, err
	}
	if stsd.AvcX == nil {
		return 0, 0, fmt.Errorf("unsupported video codec %q: only H.264 (avc1/avc3) is accepted", firstVisualCodec(stsd))
	}
	return int(stsd.AvcX.Width), int(stsd.AvcX.Height), nil
}

// firstVisualCodec names whatever visual sample entry is actually present,
// for an actionable "unsupported codec" message.
func firstVisualCodec(stsd *mp4.StsdBox) string {
	for _, e := range []*mp4.VisualSampleEntryBox{stsd.HvcX, stsd.VvcX, stsd.Av01, stsd.Avs3, stsd.VpXX, stsd.Encv} {
		if e != nil {
			return e.Type()
		}
	}
	return "unknown"
}

// audioTrackInfo requires an mp4a sample entry whose decoder config
// descriptor names the AAC object type (0x40, i.e. a "mp4a.40.*" codec
// string); any other audio codec is rejected by name.
func audioTrackInfo(trak *mp4.TrakBox) (string, error) {
	stsd, err := stsdOf(trak)
	if err != nil {
		return "", err
	}
	if stsd.Mp4a == nil {
		return "", fmt.Errorf("unsupported audio codec %q: only AAC is accepted", firstAudioCodec(stsd))
	}
	if stsd.Mp4a.Esds == nil || stsd.Mp4a.Esds.DecConfigDescriptor == nil || stsd.Mp4a.Esds.DecConfigDescriptor.ObjectType != aacObjectType {
		return "", errors.New("unsupported audio codec: mp4a stream is not AAC")
	}
	return "aac", nil
}

// firstAudioCodec names whatever audio sample entry is actually present, for
// an actionable "unsupported codec" message.
func firstAudioCodec(stsd *mp4.StsdBox) string {
	for _, e := range []*mp4.AudioSampleEntryBox{stsd.AC3, stsd.EC3, stsd.AC4, stsd.Opus, stsd.Iamf, stsd.MhXX, stsd.Enca} {
		if e != nil {
			return e.Type()
		}
	}
	return "unknown"
}

func movieDuration(moov *mp4.MoovBox) (time.Duration, error) {
	if moov.Mvhd == nil || moov.Mvhd.Timescale == 0 {
		return 0, errors.New("unable to determine video duration: mvhd box is missing or has no timescale")
	}
	seconds := float64(moov.Mvhd.Duration) / float64(moov.Mvhd.Timescale)
	return time.Duration(seconds * float64(time.Second)), nil
}
