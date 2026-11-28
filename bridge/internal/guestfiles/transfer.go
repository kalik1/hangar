package guestfiles

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/klog/v2"

	"github.com/kalik1/hangar/bridge/internal/agent"
	"github.com/kalik1/hangar/bridge/internal/apis/v1alpha1"
)

// read answers up to length bytes of a regular file from offset, read from
// the agent in guest-file-read calls of 1 MiB and passed on as they come.
// The headers carry the file's size, its mtime (where guest-exec may run
// to tell it; on Windows, where each script starts PowerShell, from offset
// 0 only), the offset and whether the answer ends at the end of the file.
func (s *session) read(w http.ResponseWriter, path string, win bool, offset, length int64) error {
	if err := s.st.gate(readCommands...); err != nil {
		return err
	}
	var mtime string
	if s.st.can(execCommands...) && (!win || offset == 0) {
		e, err := s.stat(path, win, true)
		if err != nil {
			return err
		}
		if err := regular(e, path); err != nil {
			return err
		}
		mtime = e.MTime
	}
	handle, err := s.vm.OpenFile(s.ctx, path, agent.FileReadOnly)
	if err != nil {
		return fileFailure(err, "path", path)
	}
	defer s.closeFile(handle)
	// A file of size 0 may have bytes all the same, /proc's and /sys's, and
	// some of them cannot seek to their end. It is read up to 1 MiB per call,
	// and the end is where the agent says.
	size, err := s.vm.SeekFile(s.ctx, handle, 0, agent.SeekEnd)
	if err != nil && guestCause(err.Error()) == v1alpha1.CauseInvalid {
		size, err = 0, nil
	}
	if err != nil {
		return fileFailure(err, "path", path)
	}
	want := max(min(length, size-offset), 0)
	probe := size == 0
	if probe {
		want = min(length, agent.MaxFileRead)
	}
	var first []byte
	eof := true
	if want > 0 {
		if _, err := s.vm.SeekFile(s.ctx, handle, offset, agent.SeekSet); err != nil {
			return fileFailure(err, "path", path)
		}
		if first, eof, err = s.vm.ReadFile(s.ctx, handle, int(min(want, agent.MaxFileRead))); err != nil {
			return fileFailure(err, "path", path)
		}
	}
	if probe {
		want = int64(len(first))
	} else {
		eof = offset+want >= size
	}

	hd := w.Header()
	hd.Set("Content-Type", "application/octet-stream")
	hd.Set("Content-Length", strconv.FormatInt(want, 10))
	hd.Set("Cache-Control", "no-store")
	hd.Set("X-Content-Type-Options", "nosniff")
	hd.Set(v1alpha1.HeaderFileSize, strconv.FormatInt(size, 10))
	hd.Set(v1alpha1.HeaderFileOffset, strconv.FormatInt(offset, 10))
	hd.Set(v1alpha1.HeaderFileEOF, strconv.FormatBool(eof))
	if mtime != "" {
		hd.Set(v1alpha1.HeaderFileMTime, mtime)
	}
	w.WriteHeader(http.StatusOK)
	got := int64(len(first))
	if _, err := w.Write(first); err != nil {
		return nil
	}
	for got < want {
		data, eof, err := s.vm.ReadFile(s.ctx, handle, int(min(want-got, agent.MaxFileRead)))
		if err != nil || len(data) == 0 {
			// The status is sent: the short body tells the client.
			klog.V(2).InfoS("A guest file read ended early", "vmi", s.call.Target.String(), "path", path,
				"sent", got, "want", want, "eof", eof, "err", err)
			return nil
		}
		if _, err := w.Write(data); err != nil {
			return nil
		}
		got += int64(len(data))
	}
	return nil
}

// regular checks that an entry is a regular file.
func regular(e *v1alpha1.GuestFile, path string) error {
	switch e.Type {
	case v1alpha1.FileTypeFile:
		return nil
	case v1alpha1.FileTypeDirectory:
		return failed(v1alpha1.CauseIsADirectory, "path", path+": Is a directory")
	}
	return failed(v1alpha1.CauseNotARegularFile, "path", fmt.Sprintf("%s: a %s, not a regular file", path, e.Type))
}

// readBody reads a write's body, at most MaxWriteBody bytes.
func readBody(r *http.Request) ([]byte, error) {
	if r.Body == nil {
		return nil, nil
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, v1alpha1.MaxWriteBody+1))
	var tooLarge *http.MaxBytesError
	switch {
	case errors.As(err, &tooLarge), err == nil && len(body) > v1alpha1.MaxWriteBody:
		return nil, apierrors.NewRequestEntityTooLargeError(fmt.Sprintf("a write's body is limited to %d bytes", v1alpha1.MaxWriteBody))
	case err != nil:
		return nil, apierrors.NewBadRequest(fmt.Sprintf("reading the body: %v", err))
	}
	return body, nil
}

// write writes body at offset, in guest-file-write calls of at most
// 128 KiB. With truncate (offset 0 only) the file is created or emptied
// first; without, it must be there and offset at most its size. A write at
// offset 0 is a file's first: it is checked to be a regular file (where
// guest-exec may run) and relabelled after.
func (s *session) write(path string, win bool, offset int64, truncate bool, body []byte) (*v1alpha1.GuestFileWrite, error) {
	if truncate && offset != 0 {
		return nil, invalid("offset", "offset: truncate starts the file again, at offset 0")
	}
	if err := s.st.gate(writeCommands...); err != nil {
		return nil, err
	}
	exec := s.st.can(execCommands...)
	if offset == 0 && exec {
		e, err := s.stat(path, win, true)
		var fe *fileError
		switch {
		case errors.As(err, &fe) && fe.cause == v1alpha1.CauseNotFound:
		case err != nil:
			return nil, err
		default:
			if err := regular(e, path); err != nil {
				return nil, err
			}
		}
	}
	mode := agent.FileUpdate
	if truncate {
		mode = agent.FileTruncate
	}
	handle, err := s.vm.OpenFile(s.ctx, path, mode)
	if err != nil {
		return nil, fileFailure(err, "path", path)
	}
	open := true
	defer func() {
		if open {
			s.closeFile(handle)
		}
	}()
	var size0 int64
	if !truncate {
		if size0, err = s.vm.SeekFile(s.ctx, handle, 0, agent.SeekEnd); err != nil {
			return nil, fileFailure(err, "path", path)
		}
		if offset > size0 {
			return nil, &fileError{cause: v1alpha1.CauseInvalid, field: "offset", code: http.StatusConflict,
				message: fmt.Sprintf("offset: %d is past the end of %s (%s)", offset, path, bytesText(size0))}
		}
		if offset != size0 {
			if _, err := s.vm.SeekFile(s.ctx, handle, offset, agent.SeekSet); err != nil {
				return nil, fileFailure(err, "path", path)
			}
		}
	}
	var written int64
	for rest := body; len(rest) > 0; {
		n, err := s.vm.WriteFile(s.ctx, handle, rest[:min(len(rest), agent.MaxFileWrite)])
		if err != nil {
			return nil, fileFailure(err, "path", path)
		}
		if n == 0 {
			return nil, failed(v1alpha1.CauseFailed, "path", fmt.Sprintf("%s: the guest agent wrote nothing after %s", path, bytesText(written)))
		}
		written += int64(n)
		rest = rest[n:]
	}
	open = false
	if err := s.vm.CloseFile(s.ctx, handle); err != nil {
		return nil, fileFailure(err, "path", path)
	}
	size := max(size0, offset+written)
	if offset == 0 && exec && !win {
		s.relabel(path)
	}
	s.h.uploads.wrote(s.call.Target, s.user, path, written, size, offset == 0 && truncate)
	return &v1alpha1.GuestFileWrite{Written: written, Size: size}, nil
}
