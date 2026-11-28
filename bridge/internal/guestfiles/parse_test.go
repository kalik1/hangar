package guestfiles

import (
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/kalik1/hangar/bridge/internal/apis/v1alpha1"
)

func u32(v uint32) *uint32 { return &v }
func i64(v int64) *int64   { return &v }

func sameFile(t *testing.T, what string, got, want v1alpha1.GuestFile) {
	t.Helper()
	eq := got.Name == want.Name && got.Type == want.Type && got.Size == want.Size && got.MTime == want.MTime &&
		got.User == want.User && got.Group == want.Group &&
		(got.Mode == nil) == (want.Mode == nil) && (got.Mode == nil || *got.Mode == *want.Mode) &&
		(got.UID == nil) == (want.UID == nil) && (got.UID == nil || *got.UID == *want.UID) &&
		(got.GID == nil) == (want.GID == nil) && (got.GID == nil || *got.GID == *want.GID)
	if !eq {
		t.Errorf("%s:\n got %s\nwant %s", what, show(got), show(want))
	}
}

func show(f v1alpha1.GuestFile) string {
	opt := func(p any) string {
		switch v := p.(type) {
		case *uint32:
			if v != nil {
				return fmt.Sprintf("%o", *v)
			}
		case *int64:
			if v != nil {
				return fmt.Sprint(*v)
			}
		}
		return "-"
	}
	return fmt.Sprintf("%q %s %d mode %s ids %s:%s names %q:%q %s", f.Name, f.Type, f.Size, opt(f.Mode), opt(f.UID), opt(f.GID), f.User, f.Group, f.MTime)
}

// TestParseFind: GNU find's records (findFormat), as Fedora's find prints
// them.
func TestParseFind(t *testing.T) {
	for _, tc := range []struct {
		rec  string
		want v1alpha1.GuestFile
	}{
		{"f\t5\t1764331200.1234567890\t640\t1000\t1000\tfedora\tfedora\ta.txt",
			v1alpha1.GuestFile{Name: "a.txt", Type: "file", Size: 5, Mode: u32(0o640), UID: i64(1000), GID: i64(1000),
				User: "fedora", Group: "fedora", MTime: "2025-11-28T12:00:00.123456789Z"}},
		{"d\t4096\t1764331200.0000000000\t2755\t0\t0\troot\troot\tsub",
			v1alpha1.GuestFile{Name: "sub", Type: "directory", Size: 4096, Mode: u32(0o2755), UID: i64(0), GID: i64(0),
				User: "root", Group: "root", MTime: "2025-11-28T12:00:00Z"}},
		{"l\t5\t1764331200\t777\t0\t0\troot\troot\tlink",
			v1alpha1.GuestFile{Name: "link", Type: "symlink", Size: 5, Mode: u32(0o777), UID: i64(0), GID: i64(0),
				User: "root", Group: "root", MTime: "2025-11-28T12:00:00Z"}},
		{"c\t0\t1764331200.5\t666\t0\t0\troot\troot\tnull",
			v1alpha1.GuestFile{Name: "null", Type: "charDevice", Mode: u32(0o666), UID: i64(0), GID: i64(0),
				User: "root", Group: "root", MTime: "2025-11-28T12:00:00.5Z"}},
		// No names for the ids: find prints the numbers.
		{"p\t0\t1764331200\t600\t1234\t5678\t1234\t5678\tfifo",
			v1alpha1.GuestFile{Name: "fifo", Type: "fifo", Mode: u32(0o600), UID: i64(1234), GID: i64(5678), MTime: "2025-11-28T12:00:00Z"}},
		// A tab, a newline and UTF-8 in a name stay.
		{"s\t0\t-1.5\t1777\t0\t0\troot\troot\ta\tb\nc ✓",
			v1alpha1.GuestFile{Name: "a\tb\nc ✓", Type: "socket", Mode: u32(0o1777), UID: i64(0), GID: i64(0),
				User: "root", Group: "root", MTime: "1969-12-31T23:59:58.5Z"}},
		{"D\t0\t0\t644\t0\t0\troot\troot\tdoor",
			v1alpha1.GuestFile{Name: "door", Type: "other", Mode: u32(0o644), UID: i64(0), GID: i64(0),
				User: "root", Group: "root", MTime: "1970-01-01T00:00:00Z"}},
	} {
		got, err := parseFindRecord(tc.rec)
		if err != nil {
			t.Errorf("%q: %v", tc.rec, err)
			continue
		}
		sameFile(t, tc.rec, got, tc.want)
	}
	for _, bad := range []string{"", "f\t5", "f\tx\t0\t644\t0\t0\tr\tr\tn", "f\t5\tnow\t644\t0\t0\tr\tr\tn",
		"f\t5\t0\t9999\t0\t0\tr\tr\tn", "f\t5\t0\t644\tx\t0\tr\tr\tn", "f\t5\t0\t17777\t0\t0\tr\tr\tn"} {
		if _, err := parseFindRecord(bad); err == nil {
			t.Errorf("%q parsed", bad)
		}
	}
}

func TestSplitRecords(t *testing.T) {
	recs, used := splitFindRecords([]byte("a\x00b\x00c"), 10)
	if len(recs) != 2 || used != 4 {
		t.Errorf("%q %d", recs, used)
	}
	recs, used = splitFindRecords([]byte("a\x00b\x00c\x00"), 2)
	if len(recs) != 2 || used != 4 {
		t.Errorf("limit: %q %d", recs, used)
	}
	recs, used = splitLsLines([]byte("total 8\nx\ny\nunfinished"), 10)
	if len(recs) != 2 || recs[0] != "x" || used != len("total 8\nx\ny\n") {
		t.Errorf("ls: %q %d", recs, used)
	}
}

// TestParseLs: busybox ls -lAn lines, as Alpine's busybox 1.37 prints them
// with --full-time, older busyboxes with -e, and without either.
func TestParseLs(t *testing.T) {
	now := time.Date(2026, 11, 28, 18, 30, 0, 0, time.UTC)
	for _, tc := range []struct {
		line string
		want v1alpha1.GuestFile
	}{
		{"-rw-r--r--    1 0        0                5 2026-11-28 18:12:40 +0000 jérôme ✓",
			v1alpha1.GuestFile{Name: "jérôme ✓", Type: "file", Size: 5, Mode: u32(0o644), UID: i64(0), GID: i64(0), MTime: "2026-11-28T18:12:40Z"}},
		{"drwxr-sr-x    2 1000     1000          4096 2026-11-28 18:12:40.123456789 +0100 sub dir",
			v1alpha1.GuestFile{Name: "sub dir", Type: "directory", Size: 4096, Mode: u32(0o2755), UID: i64(1000), GID: i64(1000), MTime: "2026-11-28T17:12:40.123456789Z"}},
		{"lrwxrwxrwx    1 0        0               12 2026-11-28 18:12:40 +0000 l -> jérôme ✓",
			v1alpha1.GuestFile{Name: "l", Type: "symlink", Size: 12, Mode: u32(0o777), UID: i64(0), GID: i64(0), MTime: "2026-11-28T18:12:40Z"}},
		{"crw-rw-rw-    1 0        0           1,   3 2026-11-28 18:12:40 +0000 null",
			v1alpha1.GuestFile{Name: "null", Type: "charDevice", Mode: u32(0o666), UID: i64(0), GID: i64(0), MTime: "2026-11-28T18:12:40Z"}},
		{"-rwsr-x--T    1 0        0               10 Thu Nov 28 12:00:00 2026 suid",
			v1alpha1.GuestFile{Name: "suid", Type: "file", Size: 10, Mode: u32(0o5750), UID: i64(0), GID: i64(0), MTime: "2026-11-28T12:00:00Z"}},
		{"drwxrwxrwt    9 0        0              180 Nov  8 09:05 tmp",
			v1alpha1.GuestFile{Name: "tmp", Type: "directory", Size: 180, Mode: u32(0o1777), UID: i64(0), GID: i64(0), MTime: "2026-11-08T09:05:00Z"}},
		// "Dec 24 10:00" seen on 28 November is last year's.
		{"-rw-------    1 0        0                0 Dec 24 10:00 old",
			v1alpha1.GuestFile{Name: "old", Type: "file", Mode: u32(0o600), UID: i64(0), GID: i64(0), MTime: "2025-12-24T10:00:00Z"}},
		{"-rw-r--r--    1 0        0                0 Mar  1  2024   two spaces",
			v1alpha1.GuestFile{Name: "  two spaces", Type: "file", Mode: u32(0o644), UID: i64(0), GID: i64(0), MTime: "2024-03-01T00:00:00Z"}},
	} {
		got, err := parseLsLine(tc.line, now)
		if err != nil {
			t.Errorf("%q: %v", tc.line, err)
			continue
		}
		sameFile(t, tc.line, got, tc.want)
	}
	for _, bad := range []string{"total 0", "-rw-r--r-- 1 0 0 5", "-rw-r--r--    1 root     root    5 Nov 28 12:00 x",
		"-rw-r--r--    1 0        0                5 Smarch 28 12:00 x", "?rw-r--q--    1 0        0                5 Nov 28 12:00 x",
		"-rw-r--r--    1 0        0                5 2026-11-28 18:12:40 +0000"} {
		if _, err := parseLsLine(bad, now); err == nil {
			t.Errorf("%q parsed", bad)
		}
	}
}

func TestParseStat(t *testing.T) {
	now := time.Date(2026, 11, 28, 18, 30, 0, 0, time.UTC)
	e, rest, err := parseStat([]byte("find\nf\t1\t0\t644\t0\t0\troot\troot\tx\x00more"), now)
	if err != nil || e.Name != "x" || string(rest) != "more" {
		t.Errorf("%+v %q %v", e, rest, err)
	}
	// ls -d prints the path it was given.
	e, _, err = parseStat([]byte("ls\n-rw-r--r--    1 0        0                5 2026-11-28 18:12:40 +0000 /var/tmp/a b\n"), now)
	if err != nil || e.Name != "a b" {
		t.Errorf("%+v %v", e, err)
	}
	e, _, err = parseStat([]byte("ls\ndrwxr-xr-x   19 0        0              400 2026-11-28 18:12:40 +0000 /\n"), now)
	if err != nil || e.Name != "/" {
		t.Errorf("%+v %v", e, err)
	}
	for _, bad := range []string{"", "find\n", "find\nf\t1", "stat\nx\x00"} {
		if _, _, err := parseStat([]byte(bad), now); err == nil {
			t.Errorf("%q parsed", bad)
		}
	}
}

func TestParseListHeader(t *testing.T) {
	h, err := parseListHeader("hangar-ls find 1 143 10240 17 1 hangar-ls.Ab3dE6gH9k")
	if err != nil || h.tool != "find" || h.status != 1 || h.count != 143 || h.bytes != 10240 || h.errors != 17 || !h.selinux || h.file != "hangar-ls.Ab3dE6gH9k" {
		t.Errorf("%+v %v", h, err)
	}
	h, err = parseListHeader("hangar-ls ls 0 3 120 0 0 -")
	if err != nil || h.tool != "ls" || h.file != "" || h.selinux {
		t.Errorf("%+v %v", h, err)
	}
	for _, bad := range []string{"", "hangar-ls find 0 1 1 0 0", "hangar-ls cat 0 1 1 0 0 -", "hangar-ls find x 1 1 0 0 -",
		"hangar-ls find 0 1 1 0 0 ../../etc/passwd", "hangar-ls find 0 1 1 0 0 hangar-ls.short"} {
		if _, err := parseListHeader(bad); err == nil {
			t.Errorf("%q parsed", bad)
		}
	}
}

// TestParsePowerShell: psListScript's output from Windows PowerShell 5.1,
// with an array, the one object it may print for an array of one, and a
// byte order mark.
func TestParsePowerShell(t *testing.T) {
	for _, tc := range []struct {
		out   string
		names []string
		next  *int
	}{
		{`{"entries":[{"n":"Users","y":"d","s":0,"m":"2026-11-20T09:12:33.1234567Z"},{"n":"pagefile.sys","y":"f","s":1879048192,"m":"2026-11-28T07:01:02.0000000Z"}],"next":2,"errors":0,"error":""}`,
			[]string{"Users", "pagefile.sys"}, ptr(2)},
		{`{"entries":{"n":"Documents and Settings","y":"l","s":0,"m":"2024-04-01T10:00:00.0000000Z"},"next":null,"errors":1,"error":"Access to the path 'C:\\System Volume Information' is denied."}`,
			[]string{"Documents and Settings"}, nil},
		{"\xef\xbb\xbf" + `{"entries":[],"next":null,"errors":0,"error":""}` + "\r\n", nil, nil},
	} {
		var out psList
		if err := parsePS([]byte(tc.out), &out); err != nil {
			t.Errorf("%v", err)
			continue
		}
		var names []string
		for _, p := range out.Entries {
			e, err := p.entry()
			if err != nil {
				t.Error(err)
			}
			names = append(names, e.Name)
		}
		if strings.Join(names, "|") != strings.Join(tc.names, "|") || (out.Next == nil) != (tc.next == nil) || (out.Next != nil && *out.Next != *tc.next) {
			t.Errorf("%s: %v next %v", tc.out, names, out.Next)
		}
	}
	e, err := psEntry{Name: "pagefile.sys", Type: "f", Size: 7, MTime: "2026-11-28T07:01:02.1234567Z"}.entry()
	if err != nil || e.MTime != "2026-11-28T07:01:02.1234567Z" || e.Type != "file" || e.Mode != nil || e.UID != nil {
		t.Errorf("%+v %v", e, err)
	}
	for _, bad := range []psEntry{{Name: "x", Type: "q"}, {Name: "x", Type: "f", MTime: "\\/Date(1732771200000)\\/"}} {
		if _, err := bad.entry(); err == nil {
			t.Errorf("%+v parsed", bad)
		}
	}
	var out psList
	if err := parsePS([]byte("Get-ChildItem : Cannot find path"), &out); err == nil {
		t.Error("text parsed as JSON")
	}
}

func ptr(i int) *int { return &i }

func TestMentionsPath(t *testing.T) {
	for _, msg := range []string{
		"find: '/root': Permission denied",
		"find: ‘/root’: Permission denied",
		"bfs: error: /root: Permission denied.",
		"ls: /root/: Permission denied",
		"ls: cannot open directory '/root/': Permission denied",
		`Access to the path "/root" is denied.`,
	} {
		if !mentionsPath(msg, "/root") {
			t.Errorf("%q", msg)
		}
	}
	for _, msg := range []string{"find: '/root/.ssh': Permission denied", "find: '/rootfs': Permission denied", ""} {
		if mentionsPath(msg, "/root") {
			t.Errorf("%q", msg)
		}
	}
}
