package guestfiles

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/kalik1/hangar/bridge/internal/apis/v1alpha1"
)

// The tools a Linux script lists with.
const (
	toolFind = "find"
	toolLs   = "ls"
)

// findTypes are GNU find's %y letters.
var findTypes = map[string]string{
	"f": v1alpha1.FileTypeFile,
	"d": v1alpha1.FileTypeDirectory,
	"l": v1alpha1.FileTypeSymlink,
	"b": v1alpha1.FileTypeBlockDevice,
	"c": v1alpha1.FileTypeCharDevice,
	"p": v1alpha1.FileTypeFIFO,
	"s": v1alpha1.FileTypeSocket,
}

// parseFindRecord reads one record of findFormat, without its NUL.
func parseFindRecord(rec string) (v1alpha1.GuestFile, error) {
	f := strings.SplitN(rec, "\t", 9)
	if len(f) != 9 {
		return v1alpha1.GuestFile{}, fmt.Errorf("a find record of %d fields: %q", len(f), short(rec))
	}
	e := v1alpha1.GuestFile{Name: f[8], Type: findTypes[f[0]]}
	if e.Type == "" {
		e.Type = v1alpha1.FileTypeOther
	}
	var err error
	if e.Size, err = strconv.ParseInt(f[1], 10, 64); err != nil {
		return v1alpha1.GuestFile{}, fmt.Errorf("size %q: %w", f[1], err)
	}
	mtime, err := parseEpoch(f[2])
	if err != nil {
		return v1alpha1.GuestFile{}, err
	}
	e.MTime = formatTime(mtime)
	mode, err := strconv.ParseUint(f[3], 8, 32)
	if err != nil || mode > 0o7777 {
		return v1alpha1.GuestFile{}, fmt.Errorf("mode %q", f[3])
	}
	m := uint32(mode)
	e.Mode = &m
	uid, err1 := strconv.ParseInt(f[4], 10, 64)
	gid, err2 := strconv.ParseInt(f[5], 10, 64)
	if err1 != nil || err2 != nil {
		return v1alpha1.GuestFile{}, fmt.Errorf("owner %q:%q", f[4], f[5])
	}
	e.UID, e.GID = &uid, &gid
	// find prints the number where the guest knows no name.
	if f[6] != f[4] {
		e.User = f[6]
	}
	if f[7] != f[5] {
		e.Group = f[7]
	}
	return e, nil
}

// parseEpoch reads find's %T@: seconds since the epoch with a fraction.
func parseEpoch(s string) (time.Time, error) {
	neg := strings.HasPrefix(s, "-")
	whole, frac, _ := strings.Cut(strings.TrimPrefix(s, "-"), ".")
	sec, err := strconv.ParseInt(whole, 10, 64)
	if err != nil {
		return time.Time{}, fmt.Errorf("mtime %q", s)
	}
	var nsec int64
	if frac != "" {
		if len(frac) > 9 {
			frac = frac[:9]
		}
		frac += strings.Repeat("0", 9-len(frac))
		if nsec, err = strconv.ParseInt(frac, 10, 64); err != nil {
			return time.Time{}, fmt.Errorf("mtime %q", s)
		}
	}
	if neg {
		sec, nsec = -sec, -nsec
	}
	return time.Unix(sec, nsec), nil
}

func formatTime(t time.Time) string { return t.UTC().Format(time.RFC3339Nano) }

// splitFindRecords returns the complete NUL-terminated records of b and
// the bytes they take.
func splitFindRecords(b []byte, limit int) ([]string, int) {
	var out []string
	used := 0
	for len(out) < limit {
		i := bytes.IndexByte(b[used:], 0)
		if i < 0 {
			break
		}
		out = append(out, string(b[used:used+i]))
		used += i + 1
	}
	return out, used
}

// splitLsLines returns the complete lines of b, without ls's "total"
// line, and the bytes they take.
func splitLsLines(b []byte, limit int) ([]string, int) {
	var out []string
	used := 0
	for len(out) < limit {
		i := bytes.IndexByte(b[used:], '\n')
		if i < 0 {
			break
		}
		line := string(b[used : used+i])
		used += i + 1
		if strings.HasPrefix(line, "total ") || line == "" {
			continue
		}
		out = append(out, line)
	}
	return out, used
}

// lsTypes are ls's type letters, the first of the mode.
var lsTypes = map[byte]string{
	'-': v1alpha1.FileTypeFile,
	'd': v1alpha1.FileTypeDirectory,
	'l': v1alpha1.FileTypeSymlink,
	'b': v1alpha1.FileTypeBlockDevice,
	'c': v1alpha1.FileTypeCharDevice,
	'p': v1alpha1.FileTypeFIFO,
	's': v1alpha1.FileTypeSocket,
}

var months = map[string]time.Month{
	"Jan": time.January, "Feb": time.February, "Mar": time.March, "Apr": time.April,
	"May": time.May, "Jun": time.June, "Jul": time.July, "Aug": time.August,
	"Sep": time.September, "Oct": time.October, "Nov": time.November, "Dec": time.December,
}

// parseLsLine reads one line of busybox ls -lAn, with --full-time, with
// the older -e, or without either, in UTC (the scripts set TZ):
//
//	drwxr-xr-x    2 0        0             40 2026-11-28 12:00:00 +0000 name
//	drwxr-xr-x    2 0        0             40 Thu Nov 28 12:00:00 2026 name
//	-rw-r--r--    1 1000     1000           6 Nov 28 12:00 name
//	-rw-r--r--    1 1000     1000           6 Nov 28  2024 name
//	crw-rw-rw-    1 0        0          1,   3 Nov 28 12:00 null
//	lrwxrwxrwx    1 0        0             12 Nov 28 12:00 link -> target
//
// now places a date ls printed without its year (within the last six
// months). The name is what follows the date, a link's without " -> target".
func parseLsLine(line string, now time.Time) (v1alpha1.GuestFile, error) {
	fail := func(what string) (v1alpha1.GuestFile, error) {
		return v1alpha1.GuestFile{}, fmt.Errorf("an ls line with %s: %q", what, short(line))
	}
	toks, ends := fields(line)
	if len(toks) < 8 || len(toks[0]) < 10 {
		return fail("too few fields")
	}
	e := v1alpha1.GuestFile{Type: lsTypes[toks[0][0]]}
	if e.Type == "" {
		e.Type = v1alpha1.FileTypeOther
	}
	mode, ok := lsMode(toks[0][1:10])
	if !ok {
		return fail("an unknown mode")
	}
	e.Mode = &mode
	uid, err1 := strconv.ParseInt(toks[2], 10, 64)
	gid, err2 := strconv.ParseInt(toks[3], 10, 64)
	if err1 != nil || err2 != nil {
		return fail("an owner that is not a number")
	}
	e.UID, e.GID = &uid, &gid
	i := 4
	if strings.HasSuffix(toks[i], ",") {
		// A device: "major, minor" in place of the size.
		i += 2
	} else {
		size, err := strconv.ParseInt(toks[i], 10, 64)
		if err != nil {
			return fail("a size that is not a number")
		}
		e.Size = size
		i++
	}
	t, n, ok := lsDate(toks[i:], now)
	if !ok || i+n >= len(toks) {
		return fail("a date ls does not print")
	}
	e.MTime = formatTime(t)
	name := line[ends[i+n-1]+1:]
	if e.Type == v1alpha1.FileTypeSymlink {
		if j := strings.Index(name, " -> "); j >= 0 {
			name = name[:j]
		}
	}
	if name == "" {
		return fail("no name")
	}
	e.Name = name
	return e, nil
}

// fields splits s at runs of spaces, and returns where each field ends.
func fields(s string) ([]string, []int) {
	var toks []string
	var ends []int
	for i := 0; i < len(s); {
		for i < len(s) && s[i] == ' ' {
			i++
		}
		j := i
		for j < len(s) && s[j] != ' ' {
			j++
		}
		if j > i {
			toks = append(toks, s[i:j])
			ends = append(ends, j)
		}
		i = j
	}
	return toks, ends
}

// lsMode reads "rwxr-xr-x" with its s, S, t and T.
func lsMode(s string) (uint32, bool) {
	var m uint32
	bits := []uint32{0o400, 0o200, 0o100, 0o40, 0o20, 0o10, 0o4, 0o2, 0o1}
	special := []uint32{0o4000, 0o2000, 0o1000}
	for i := 0; i < 9; i++ {
		c := s[i]
		switch {
		case c == '-':
		case i%3 == 0 && c == 'r', i%3 == 1 && c == 'w', i%3 == 2 && c == 'x':
			m |= bits[i]
		case i%3 == 2 && (c == 's' && i < 6 || c == 't' && i == 8):
			m |= bits[i] | special[i/3]
		case i%3 == 2 && (c == 'S' && i < 6 || c == 'T' && i == 8):
			m |= special[i/3]
		default:
			return 0, false
		}
	}
	return m, true
}

// lsDate reads the date at the start of toks and how many fields it takes.
func lsDate(toks []string, now time.Time) (time.Time, int, bool) {
	// -e: "Thu Nov 28 12:00:00 2026"
	if len(toks) >= 5 && len(toks[0]) == 3 && months[toks[1]] != 0 && strings.Count(toks[3], ":") == 2 {
		if t, err := time.Parse("Jan 2 15:04:05 2006", strings.Join(toks[1:5], " ")); err == nil {
			return t, 5, true
		}
	}
	// --full-time: "2026-11-28 12:00:00.000000000 +0000"
	if len(toks) >= 3 && strings.Count(toks[0], "-") == 2 && strings.Contains(toks[1], ":") {
		if t, err := time.Parse("2006-01-02 15:04:05.999999999 -0700", strings.Join(toks[:3], " ")); err == nil {
			return t, 3, true
		}
	}
	if len(toks) < 3 || months[toks[0]] == 0 {
		return time.Time{}, 0, false
	}
	day, err := strconv.Atoi(toks[1])
	if err != nil {
		return time.Time{}, 0, false
	}
	// "Nov 28  2024": an old file, to the day.
	if year, err := strconv.Atoi(toks[2]); err == nil {
		return time.Date(year, months[toks[0]], day, 0, 0, 0, 0, time.UTC), 3, true
	}
	// "Nov 28 12:00": within the last six months.
	hm, err := time.Parse("15:04", toks[2])
	if err != nil {
		return time.Time{}, 0, false
	}
	now = now.UTC()
	t := time.Date(now.Year(), months[toks[0]], day, hm.Hour(), hm.Minute(), 0, 0, time.UTC)
	if t.After(now.Add(24 * time.Hour)) {
		t = t.AddDate(-1, 0, 0)
	}
	return t, 3, true
}

// parseRecord reads one record of a Linux script's tool.
func parseRecord(tool, rec string, now time.Time) (v1alpha1.GuestFile, error) {
	if tool == toolLs {
		return parseLsLine(rec, now)
	}
	return parseFindRecord(rec)
}

// parseStat reads what st printed: the tool on a line, then one record.
// It returns the rest of out after the record.
func parseStat(out []byte, now time.Time) (v1alpha1.GuestFile, []byte, error) {
	tool, rest, ok := bytes.Cut(out, []byte("\n"))
	if !ok || (string(tool) != toolFind && string(tool) != toolLs) {
		return v1alpha1.GuestFile{}, nil, fmt.Errorf("no record in %q", short(string(out)))
	}
	sep := byte(0)
	if string(tool) == toolLs {
		sep = '\n'
	}
	rec, rest, ok := bytes.Cut(rest, []byte{sep})
	if !ok {
		return v1alpha1.GuestFile{}, nil, fmt.Errorf("an unfinished record %q", short(string(out)))
	}
	e, err := parseRecord(string(tool), string(rec), now)
	if err == nil && string(tool) == toolLs {
		// ls -d prints the path it was given.
		if i := strings.LastIndexByte(e.Name, '/'); i >= 0 && i < len(e.Name)-1 {
			e.Name = e.Name[i+1:]
		}
	}
	return e, rest, err
}

// listHeader is the first line of listScript's output.
type listHeader struct {
	tool    string
	status  int
	count   int
	bytes   int64
	errors  int
	selinux bool
	// file is the temporary file's name, "" when the entries follow.
	file string
}

func parseListHeader(line string) (listHeader, error) {
	f := strings.Fields(line)
	if len(f) != 8 || f[0] != "hangar-ls" || (f[1] != toolFind && f[1] != toolLs) {
		return listHeader{}, fmt.Errorf("an unknown listing header %q", short(line))
	}
	h := listHeader{tool: f[1], selinux: f[6] == "1"}
	var errs [4]error
	h.status, errs[0] = strconv.Atoi(f[2])
	h.count, errs[1] = strconv.Atoi(f[3])
	h.bytes, errs[2] = strconv.ParseInt(f[4], 10, 64)
	h.errors, errs[3] = strconv.Atoi(f[5])
	for _, err := range errs {
		if err != nil {
			return listHeader{}, fmt.Errorf("listing header %q: %w", short(line), err)
		}
	}
	if f[7] != "-" {
		if !listTempName.MatchString(f[7]) {
			return listHeader{}, fmt.Errorf("listing header %q: an unexpected file name", short(line))
		}
		h.file = f[7]
	}
	return h, nil
}

// psEntry is the record of psPrelude's Entry.
type psEntry struct {
	Name  string `json:"n"`
	Type  string `json:"y"`
	Size  int64  `json:"s"`
	MTime string `json:"m"`
	Hash  string `json:"h"`
}

var psTypes = map[string]string{
	"f": v1alpha1.FileTypeFile,
	"d": v1alpha1.FileTypeDirectory,
	"l": v1alpha1.FileTypeSymlink,
}

func (p psEntry) entry() (v1alpha1.GuestFile, error) {
	e := v1alpha1.GuestFile{Name: p.Name, Type: psTypes[p.Type], Size: p.Size}
	if e.Type == "" {
		return e, fmt.Errorf("an entry of unknown type %q", p.Type)
	}
	if p.MTime != "" {
		t, err := time.Parse(time.RFC3339Nano, p.MTime)
		if err != nil {
			return e, fmt.Errorf("mtime %q: %w", p.MTime, err)
		}
		e.MTime = formatTime(t)
	}
	return e, nil
}

// psList is psListScript's output.
type psList struct {
	Entries psEntries `json:"entries"`
	Next    *int      `json:"next"`
	Errors  int       `json:"errors"`
	Error   string    `json:"error"`
}

// psEntries reads an array of entries, or the one entry Windows
// PowerShell 5.1 sometimes prints in place of an array of one.
type psEntries []psEntry

func (p *psEntries) UnmarshalJSON(b []byte) error {
	b = bytes.TrimSpace(b)
	switch {
	case bytes.Equal(b, []byte("null")):
		*p = nil
		return nil
	case len(b) > 0 && b[0] == '{':
		var one psEntry
		if err := json.Unmarshal(b, &one); err != nil {
			return err
		}
		*p = psEntries{one}
		return nil
	}
	var many []psEntry
	err := json.Unmarshal(b, &many)
	*p = many
	return err
}

// parsePS reads a PowerShell script's JSON output; PowerShell may start it
// with a byte order mark.
func parsePS(out []byte, v any) error {
	out = bytes.TrimPrefix(bytes.TrimSpace(out), []byte("\xef\xbb\xbf"))
	if err := json.Unmarshal(out, v); err != nil {
		return fmt.Errorf("the PowerShell output is not what the script prints: %w (%q)", err, short(string(out)))
	}
	return nil
}

func short(s string) string {
	if len(s) > 160 {
		return s[:160] + "..."
	}
	return s
}
