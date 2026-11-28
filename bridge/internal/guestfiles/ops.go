package guestfiles

import (
	"bytes"
	"context"
	"fmt"
	"strconv"
	"strings"
	"time"

	"k8s.io/klog/v2"

	"github.com/kalik1/hangar/bridge/internal/agent"
	"github.com/kalik1/hangar/bridge/internal/apis/v1alpha1"
)

func (s *session) tempDir() string {
	if s.h.TempDir != "" {
		return s.h.TempDir
	}
	return guestTempDir
}

func flag(b bool) string {
	if b {
		return "1"
	}
	return "0"
}

// script runs the program sc builds (a Linux script, or a Windows one)
// once guest-info lets guest-exec run, and returns its standard output. A
// status other than 0 is the error the status or the message names, about
// the parameter param; what starts the message.
func (s *session) script(sc func() (agent.Command, error), wait time.Duration, param, what string) ([]byte, error) {
	if err := s.st.gate(execCommands...); err != nil {
		return nil, err
	}
	cmd, err := sc()
	if err != nil {
		return nil, invalid(param, err.Error())
	}
	res, err := s.vm.Exec(s.ctx, cmd, wait)
	if err != nil {
		return nil, err
	}
	if res.ExitCode != 0 {
		return nil, scriptFailure(res, param, what)
	}
	return res.Stdout, nil
}

// ps runs a Windows script with its parameters and decodes its JSON output
// into out.
func (s *session) ps(sc func() (agent.Command, error), wait time.Duration, param, what string, out any) error {
	stdout, err := s.script(sc, wait, param, what)
	if err != nil {
		return err
	}
	if err := parsePS(stdout, out); err != nil {
		return &agent.Error{Command: agent.CmdExec, Reason: agent.AgentError, Message: err.Error()}
	}
	return nil
}

// badOutput is a script's output the bridge cannot read.
func badOutput(err error) error {
	return &agent.Error{Command: agent.CmdExec, Reason: agent.AgentError,
		Message: fmt.Sprintf("the guest's answer is not what the bridge's script prints: %v", err)}
}

// list lists a directory: the first page without a cursor, the next ones
// with it.
func (s *session) list(path string, win bool, cur *cursor, limit int) (*v1alpha1.GuestFileList, error) {
	if win {
		return s.listWindows(path, cur, limit)
	}
	if cur != nil {
		return s.page(cur, limit)
	}
	if err := s.st.gate(execCommands...); err != nil {
		return nil, err
	}
	cmd, err := agent.ShellScript(listScript, path, strconv.Itoa(limit), strconv.Itoa(listInlineMax), s.tempDir())
	if err != nil {
		return nil, invalid("path", err.Error())
	}
	res, err := s.vm.Exec(s.ctx, cmd, execWait)
	if err != nil {
		return nil, err
	}
	if res.ExitCode != 0 {
		return nil, scriptFailure(res, "path", path)
	}
	line, rest, _ := bytes.Cut(res.Stdout, []byte("\n"))
	h, err := parseListHeader(string(line))
	if err != nil {
		return nil, badOutput(err)
	}
	msg := oneLine(string(res.Stderr))
	if h.status != 0 && h.count == 0 && mentionsPath(msg, path) {
		// The directory itself could not be read.
		if h.file != "" {
			s.unlist(h.file)
		}
		cause := guestCause(msg)
		if cause == "" {
			cause = v1alpha1.CauseFailed
		}
		return nil, failed(cause, "path", fmt.Sprintf("%s: %s", path, deniedHint(cause, msg)))
	}
	c := &cursor{Version: cursorVersion, Path: pathHash(path), Tool: h.tool, File: h.file}
	if h.status != 0 {
		c.Partial, c.Reason = true, partialReason(h, msg)
	}
	if h.file != "" {
		return s.page(c, limit)
	}
	split := splitFindRecords
	if h.tool == toolLs {
		split = splitLsLines
	}
	recs, _ := split(rest, limit)
	return s.entries(h.tool, recs, c, nil), nil
}

// entries parses a page's records into a list; next is the cursor of the
// next page, or nil. A record the bridge cannot read makes the page
// partial.
func (s *session) entries(tool string, recs []string, c *cursor, next *cursor) *v1alpha1.GuestFileList {
	list := &v1alpha1.GuestFileList{Entries: make([]v1alpha1.GuestFile, 0, len(recs)), Partial: c.Partial, PartialReason: c.Reason}
	now := s.h.clock.Now()
	bad := 0
	var first error
	for _, rec := range recs {
		e, err := parseRecord(tool, rec, now)
		if err != nil {
			bad++
			if first == nil {
				first = err
			}
			continue
		}
		list.Entries = append(list.Entries, e)
	}
	if bad > 0 {
		reason := fmt.Sprintf("the bridge could not read %d entries the guest listed (%v)", bad, first)
		list.Partial = true
		if list.PartialReason == "" {
			list.PartialReason = reason
		} else {
			list.PartialReason += "; " + reason
		}
		if next != nil {
			next.Partial, next.Reason = true, list.PartialReason
		}
	}
	if next != nil {
		list.Cursor = next.encode()
	}
	return list
}

// page reads one page of a listing's temporary file: one guest-file-read
// of up to 1 MiB from the cursor's offset. The last page removes the file.
func (s *session) page(c *cursor, limit int) (*v1alpha1.GuestFileList, error) {
	if err := s.st.gate(pageCommands...); err != nil {
		return nil, err
	}
	file := s.tempDir() + "/" + c.File
	handle, err := s.vm.OpenFile(s.ctx, file, agent.FileReadOnly)
	if err != nil {
		if fe, ok := fileFailure(err, "cursor", file).(*fileError); ok && fe.cause == v1alpha1.CauseNotFound {
			return nil, expired()
		}
		return nil, err
	}
	data, eof, err := s.readAt(handle, c.Offset)
	s.closeFile(handle)
	if err != nil {
		return nil, err
	}
	split := splitFindRecords
	if c.Tool == toolLs {
		split = splitLsLines
	}
	recs, used := split(data, limit)
	if used == 0 && len(data) == agent.MaxFileRead {
		return nil, badOutput(fmt.Errorf("a record over %d bytes in %s", agent.MaxFileRead, file))
	}
	var next *cursor
	if eof && (used == len(data) || len(recs) < limit) {
		// The end: what may follow the last record is no record.
		s.unlist(c.File)
	} else {
		n := *c
		n.Offset += int64(used)
		next = &n
	}
	return s.entries(c.Tool, recs, c, next), nil
}

// readAt reads up to MaxFileRead bytes of a handle at offset.
func (s *session) readAt(handle, offset int64) ([]byte, bool, error) {
	if offset > 0 {
		if _, err := s.vm.SeekFile(s.ctx, handle, offset, agent.SeekSet); err != nil {
			return nil, false, err
		}
	}
	return s.vm.ReadFile(s.ctx, handle, agent.MaxFileRead)
}

// unlist removes a listing's temporary file. A failure is logged: the next
// listing removes what is older than 30 minutes.
func (s *session) unlist(name string) {
	if !listTempName.MatchString(name) {
		return
	}
	_, err := s.script(func() (agent.Command, error) { return agent.ShellScript(unlistScript, s.tempDir(), name) },
		execWait, "cursor", "removing the listing's temporary file")
	if err != nil {
		klog.V(2).InfoS("Removing a listing's temporary file in the guest", "vmi", s.call.Target.String(), "file", name, "err", err)
	}
}

// closeFile closes a handle, also when the call is over: the agent keeps a
// handle until it is closed.
func (s *session) closeFile(handle int64) {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(s.ctx), agent.DefaultCallTimeout)
	defer cancel()
	if err := s.vm.CloseFile(ctx, handle); err != nil {
		klog.ErrorS(err, "Closing a file in the guest", "vmi", s.call.Target.String(), "handle", handle)
	}
}

// mentionsPath reports whether an error message is about path itself, as
// find, bfs, ls and PowerShell name it.
func mentionsPath(msg, path string) bool {
	first, _, _ := strings.Cut(msg, "; ")
	for _, p := range []string{path, path + "/"} {
		for _, form := range []string{"'" + p + "'", "‘" + p + "’", `"` + p + `"`, ": " + p + ": ", " " + p + ": "} {
			if strings.Contains(first, form) {
				return true
			}
		}
		if strings.HasPrefix(first, p+": ") {
			return true
		}
	}
	return false
}

// partialReason says why a listing is partial.
func partialReason(h listHeader, msg string) string {
	first, _, _ := strings.Cut(msg, "; ")
	if len(first) > 200 {
		first = first[:200] + "..."
	}
	what := fmt.Sprintf("the guest agent could not read %d entries of this directory, which the listing leaves out", max(h.errors, 1))
	if h.selinux {
		what = "SELinux confines the guest agent in this guest: " + what
	}
	if first == "" {
		return fmt.Sprintf("%s (%s ended with status %d)", what, h.tool, h.status)
	}
	return fmt.Sprintf("%s (%s)", what, first)
}

func (s *session) listWindows(path string, cur *cursor, limit int) (*v1alpha1.GuestFileList, error) {
	skip := 0
	if cur != nil {
		skip = cur.Skip
	}
	var out psList
	err := s.ps(func() (agent.Command, error) {
		return agent.PowerShellScript(psListScript, map[string]any{"path": path, "skip": skip, "limit": limit, "max": listInlineMax})
	}, execWait, "path", path, &out)
	if err != nil {
		return nil, err
	}
	if len(out.Entries) == 0 && out.Errors > 0 && skip == 0 && mentionsPath(out.Error, path) {
		cause := guestCause(out.Error)
		if cause == "" {
			cause = v1alpha1.CauseFailed
		}
		return nil, failed(cause, "path", fmt.Sprintf("%s: %s", path, oneLine(out.Error)))
	}
	list := &v1alpha1.GuestFileList{Entries: make([]v1alpha1.GuestFile, 0, len(out.Entries))}
	if cur != nil {
		list.Partial, list.PartialReason = cur.Partial, cur.Reason
	}
	if out.Errors > 0 {
		list.Partial = true
		list.PartialReason = fmt.Sprintf("the guest agent could not read %d entries of this directory, which the listing leaves out (%s)",
			out.Errors, oneLine(out.Error))
	}
	bad := 0
	for _, p := range out.Entries {
		e, err := p.entry()
		if err != nil {
			bad++
			continue
		}
		list.Entries = append(list.Entries, e)
	}
	if bad > 0 {
		list.Partial = true
		list.PartialReason = strings.TrimPrefix(list.PartialReason+fmt.Sprintf("; the bridge could not read %d entries the guest listed", bad), "; ")
	}
	if out.Next != nil {
		if *out.Next <= skip {
			return nil, badOutput(fmt.Errorf("the next entry %d is not after %d", *out.Next, skip))
		}
		list.Cursor = cursor{Version: cursorVersion, Path: pathHash(path), Skip: *out.Next,
			Partial: list.Partial, Reason: list.PartialReason}.encode()
	}
	return list, nil
}

// stat returns a path's entry, following a link with follow.
func (s *session) stat(path string, win, follow bool) (*v1alpha1.GuestFile, error) {
	if win {
		var p psEntry
		err := s.ps(func() (agent.Command, error) {
			return agent.PowerShellScript(psStatScript, map[string]any{"path": path})
		}, execWait, "path", path, &p)
		if err != nil {
			return nil, err
		}
		return psFile(p)
	}
	out, err := s.script(func() (agent.Command, error) { return agent.ShellScript(statScript, path, flag(follow)) }, execWait, "path", path)
	if err != nil {
		return nil, err
	}
	return s.statRecord(out)
}

func (s *session) statRecord(out []byte) (*v1alpha1.GuestFile, error) {
	e, _, err := parseStat(out, s.h.clock.Now())
	if err != nil {
		return nil, badOutput(err)
	}
	return &e, nil
}

func psFile(p psEntry) (*v1alpha1.GuestFile, error) {
	e, err := p.entry()
	if err != nil {
		return nil, badOutput(err)
	}
	return &e, nil
}

// hash returns a regular file's sha256, with its size and mtime.
func (s *session) hash(path string, win bool) (*v1alpha1.GuestFileHash, error) {
	var e *v1alpha1.GuestFile
	var sum string
	if win {
		var p psEntry
		err := s.ps(func() (agent.Command, error) {
			return agent.PowerShellScript(psHashScript, map[string]any{"path": path})
		}, longWait, "path", path, &p)
		if err != nil {
			return nil, err
		}
		if e, err = psFile(p); err != nil {
			return nil, err
		}
		sum = p.Hash
	} else {
		out, err := s.script(func() (agent.Command, error) { return agent.ShellScript(hashScript, path) }, longWait, "path", path)
		if err != nil {
			return nil, err
		}
		line, rest, _ := bytes.Cut(out, []byte("\n"))
		sum = string(line)
		if e, err = s.statRecord(rest); err != nil {
			return nil, err
		}
	}
	if !isHex64(sum) {
		return nil, badOutput(fmt.Errorf("a sha256 of %q", short(sum)))
	}
	return &v1alpha1.GuestFileHash{Algorithm: "sha256", Hash: strings.ToLower(sum), Size: e.Size, MTime: e.MTime}, nil
}

func isHex64(s string) bool {
	if len(s) != 64 {
		return false
	}
	for _, c := range s {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F') {
			return false
		}
	}
	return true
}

// mkdir makes a directory, and its parents unless exclusive; created is
// false when a directory was there (not exclusive).
func (s *session) mkdir(path string, win, exclusive bool) (*v1alpha1.GuestFile, bool, error) {
	var e *v1alpha1.GuestFile
	var created bool
	if win {
		var out struct {
			Created bool    `json:"created"`
			Entry   psEntry `json:"entry"`
		}
		err := s.ps(func() (agent.Command, error) {
			return agent.PowerShellScript(psMkdirScript, map[string]any{"path": path, "exclusive": exclusive})
		}, execWait, "path", path, &out)
		if err != nil {
			return nil, false, err
		}
		if e, err = psFile(out.Entry); err != nil {
			return nil, false, err
		}
		created = out.Created
	} else {
		out, err := s.script(func() (agent.Command, error) { return agent.ShellScript(mkdirScript, path, flag(exclusive)) }, execWait, "path", path)
		if err != nil {
			return nil, false, err
		}
		line, rest, _ := bytes.Cut(out, []byte("\n"))
		created = string(line) == "created"
		if e, err = s.statRecord(rest); err != nil {
			return nil, false, err
		}
	}
	if created {
		s.record(ReasonDirectoryCreated, fmt.Sprintf("%s created the directory %s", s.user, path))
	}
	return e, created, nil
}

// create makes an empty regular file: exclusive, nothing may be there;
// otherwise a file there is emptied.
func (s *session) create(path string, win, exclusive bool) (*v1alpha1.GuestFile, error) {
	var e *v1alpha1.GuestFile
	if win {
		var p psEntry
		err := s.ps(func() (agent.Command, error) {
			return agent.PowerShellScript(psCreateScript, map[string]any{"path": path, "exclusive": exclusive})
		}, execWait, "path", path, &p)
		if err != nil {
			return nil, err
		}
		if e, err = psFile(p); err != nil {
			return nil, err
		}
	} else {
		out, err := s.script(func() (agent.Command, error) { return agent.ShellScript(createScript, path, flag(exclusive)) }, execWait, "path", path)
		if err != nil {
			return nil, err
		}
		if e, err = s.statRecord(out); err != nil {
			return nil, err
		}
	}
	s.h.uploads.finish(s.call.Target.UID, func(p string) bool { return p == path })
	s.record(ReasonCreated, fmt.Sprintf("%s created the file %s", s.user, path))
	return e, nil
}

// rename renames from to to: exclusive, nothing may be at to; otherwise a
// file or a link there is replaced, never a directory.
func (s *session) rename(from, to string, win, exclusive bool) (*v1alpha1.GuestFile, error) {
	var e *v1alpha1.GuestFile
	if win {
		var p psEntry
		err := s.ps(func() (agent.Command, error) {
			return agent.PowerShellScript(psRenameScript, map[string]any{"from": from, "to": to, "exclusive": exclusive})
		}, longWait, "from", from, &p)
		if err != nil {
			return nil, err
		}
		if e, err = psFile(p); err != nil {
			return nil, err
		}
	} else {
		out, err := s.script(func() (agent.Command, error) { return agent.ShellScript(renameScript, from, to, flag(exclusive)) }, longWait, "from", from)
		if err != nil {
			return nil, err
		}
		if e, err = s.statRecord(out); err != nil {
			return nil, err
		}
	}
	s.h.uploads.finish(s.call.Target.UID, func(p string) bool { return under(p, from, win) || under(p, to, win) })
	s.record(ReasonRenamed, fmt.Sprintf("%s renamed %s to %s", s.user, from, to))
	return e, nil
}

// chown sets a Linux file's owner, group or both.
func (s *session) chown(path string, win bool, owner, group string) (*v1alpha1.GuestFile, error) {
	if win {
		return nil, failed(v1alpha1.CauseNotSupported, "owner", "chown is for Linux guests: on Windows the agent's files are SYSTEM's")
	}
	spec := owner
	if group != "" {
		spec += ":" + group
	}
	out, err := s.script(func() (agent.Command, error) { return agent.ShellScript(chownScript, path, spec) }, execWait, "path", path)
	if err != nil {
		return nil, err
	}
	e, err := s.statRecord(out)
	if err != nil {
		return nil, err
	}
	s.record(ReasonOwnerChanged, fmt.Sprintf("%s changed the owner of %s to %s", s.user, path, spec))
	return e, nil
}

// remove deletes a file, a link, an empty directory, or with recursive a
// directory and everything in it.
func (s *session) remove(path string, win, recursive bool) error {
	var e *v1alpha1.GuestFile
	if win {
		var p psEntry
		err := s.ps(func() (agent.Command, error) {
			return agent.PowerShellScript(psDeleteScript, map[string]any{"path": path, "recursive": recursive})
		}, longWait, "path", path, &p)
		if err != nil {
			return err
		}
		if e, err = psFile(p); err != nil {
			return err
		}
	} else {
		out, err := s.script(func() (agent.Command, error) { return agent.ShellScript(deleteScript, path, flag(recursive)) }, longWait, "path", path)
		if err != nil {
			return err
		}
		if e, err = s.statRecord(out); err != nil {
			return err
		}
	}
	s.h.uploads.finish(s.call.Target.UID, func(p string) bool { return under(p, path, win) })
	msg := fmt.Sprintf("%s deleted %s (%s)", s.user, path, bytesText(e.Size))
	if e.Type == v1alpha1.FileTypeDirectory {
		msg = fmt.Sprintf("%s deleted the directory %s", s.user, path)
		if recursive {
			msg += " and everything in it"
		}
	}
	s.record(ReasonDeleted, msg)
	return nil
}

// under reports whether p is dir or a path in it.
func under(p, dir string, win bool) bool {
	sep := "/"
	if win {
		sep = `\`
	}
	return p == dir || strings.HasPrefix(p, strings.TrimSuffix(dir, sep)+sep)
}

// relabel restores the SELinux label of what the agent created, on Linux
// guests with SELinux enabled and restorecon; elsewhere it does nothing. A
// failure is logged: the file is there.
func (s *session) relabel(path string) {
	if !s.st.can(execCommands...) {
		return
	}
	_, err := s.script(func() (agent.Command, error) { return agent.ShellScript(relabelScript, path) }, execWait, "path", "relabelling "+path)
	if err != nil {
		klog.V(2).InfoS("Relabelling a file in the guest", "vmi", s.call.Target.String(), "path", path, "err", err)
	}
}
