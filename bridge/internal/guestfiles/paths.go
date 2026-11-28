package guestfiles

import (
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/kalik1/hangar/bridge/internal/agent"
)

// A guest path, as a client gives it, is checked and cleaned before any
// command carries it:
//
//   - Linux: absolute ("/..."), at most agent.MaxPath bytes of UTF-8, no NUL;
//     repeated and trailing slashes are dropped.
//   - Windows: a drive ("C:\..." or "C:/..."), the same limits, none of
//     <>"|?* or control characters; slashes become backslashes.
//   - Neither may have a "." or ".." component: a path names one place, and
//     a client cannot reach "/" through "/a/..".
//
// A path is only ever a program's argument or a guest-file-open's path,
// never part of a script.

// cleanPath checks and cleans a client's path for the guest's OS.
func cleanPath(param, p string, windows bool) (string, error) {
	bad := func(format string, a ...any) error {
		return invalid(param, fmt.Sprintf("%s: ", param)+fmt.Sprintf(format, a...))
	}
	switch {
	case p == "":
		return "", bad("a path is needed")
	case len(p) > agent.MaxPath:
		return "", bad("the path is %d bytes, over %d", len(p), agent.MaxPath)
	case !utf8.ValidString(p):
		return "", bad("the path is not UTF-8")
	case strings.IndexByte(p, 0) >= 0:
		return "", bad("the path has a NUL byte")
	}
	if windows {
		return cleanWindows(p, bad)
	}
	if !strings.HasPrefix(p, "/") {
		return "", bad("%q is not absolute: a Linux path starts with /", p)
	}
	parts := []string{}
	for _, c := range strings.Split(p, "/") {
		switch c {
		case "":
			continue
		case ".", "..":
			return "", bad("%q has a %q component", p, c)
		}
		parts = append(parts, c)
	}
	return "/" + strings.Join(parts, "/"), nil
}

func cleanWindows(p string, bad func(string, ...any) error) (string, error) {
	p = strings.ReplaceAll(p, "/", `\`)
	if !isDrivePath(p) {
		return "", bad("%q is not a drive path such as C:\\Users", p)
	}
	drive := strings.ToUpper(p[:1]) + `:\`
	parts := []string{}
	for _, c := range strings.Split(p[3:], `\`) {
		switch c {
		case "":
			continue
		case ".", "..":
			return "", bad("%q has a %q component", p, c)
		}
		if i := strings.IndexFunc(c, func(r rune) bool {
			return r < 0x20 || strings.ContainsRune(`<>:"|?*`, r)
		}); i >= 0 {
			return "", bad("%q has a character Windows does not allow in a name: %q", p, c[i:i+1])
		}
		parts = append(parts, c)
	}
	return drive + strings.Join(parts, `\`), nil
}

// isDrivePath reports whether p starts with a drive and a separator, "C:\".
func isDrivePath(p string) bool {
	return len(p) >= 3 && (p[0] >= 'A' && p[0] <= 'Z' || p[0] >= 'a' && p[0] <= 'z') && p[1] == ':' && (p[2] == '\\' || p[2] == '/')
}

// looksWindows guesses a guest's OS from a path, when the agent did not say.
func looksWindows(p string) bool { return isDrivePath(p) }

// isRoot reports whether a clean path is a file system's root, which the
// bridge never deletes or renames.
func isRoot(p string, windows bool) bool {
	if windows {
		return len(p) == 3
	}
	return p == "/"
}

// validOwner checks a chown owner or group: a name or a number, never
// something chown would read as an option or a separator.
func validOwner(param, s string) error {
	switch {
	case s == "":
		return nil
	case len(s) > 256:
		return invalid(param, fmt.Sprintf("%s: over 256 bytes", param))
	case s[0] == '-':
		return invalid(param, fmt.Sprintf("%s: %q starts with -", param, s))
	}
	for _, r := range s {
		ok := r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || strings.ContainsRune("._-@$\\", r)
		if !ok {
			return invalid(param, fmt.Sprintf("%s: %q has a character a user or group name does not have", param, s))
		}
	}
	return nil
}
