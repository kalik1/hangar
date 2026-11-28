package guestfiles

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"regexp"

	"github.com/kalik1/hangar/bridge/internal/apis/v1alpha1"
)

// listTempName is a listing's temporary file name, as listScript's mktemp
// makes it.
var listTempName = regexp.MustCompile(listTempPattern)

// cursor is where the next page of a listing starts. A client gets it
// opaque (base64url of JSON) and gives it back as it is.
//
// On Linux a long listing is a temporary file in the guest's /var/tmp,
// written once by the first call and read by the next ones: the cursor
// names it and the offset of the next record. On Windows, where the
// listing runs again for each page, it is the index of the next entry.
// Either way it holds what the first page said of the listing (partial),
// and a hash of the path, so a cursor serves only its own listing.
type cursor struct {
	Version int    `json:"v"`
	Path    string `json:"h"`
	// Linux.
	Tool   string `json:"t,omitempty"`
	File   string `json:"f,omitempty"`
	Offset int64  `json:"o,omitempty"`
	// Windows.
	Skip int `json:"i,omitempty"`
	// What the first call found.
	Partial bool   `json:"p,omitempty"`
	Reason  string `json:"r,omitempty"`
}

const cursorVersion = 1

// maxCursorReason bounds the partial reason a cursor carries.
const maxCursorReason = 512

func pathHash(path string) string {
	sum := sha256.Sum256([]byte(path))
	return hex.EncodeToString(sum[:8])
}

func (c cursor) encode() string {
	if len(c.Reason) > maxCursorReason {
		c.Reason = c.Reason[:maxCursorReason]
	}
	b, _ := json.Marshal(c)
	return base64.RawURLEncoding.EncodeToString(b)
}

// decodeCursor reads a client's cursor for the listing of path.
func decodeCursor(s, path string, windows bool) (*cursor, error) {
	bad := invalid("cursor", "the cursor is not one this listing gave: list again without it")
	if len(s) > 4096 {
		return nil, bad
	}
	b, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		return nil, bad
	}
	var c cursor
	if err := json.Unmarshal(b, &c); err != nil || c.Version != cursorVersion || c.Path != pathHash(path) {
		return nil, bad
	}
	switch {
	case windows && (c.Skip < 1 || c.File != ""):
		return nil, bad
	case !windows && (!listTempName.MatchString(c.File) || c.Offset < 0 || (c.Tool != toolFind && c.Tool != toolLs)):
		return nil, bad
	}
	return &c, nil
}

// expired is the error of a cursor whose listing is gone.
func expired() error {
	return failed(v1alpha1.CauseExpired, "cursor", "the listing behind this cursor is gone from the guest (it is removed after 30 minutes, "+
		"or the guest restarted): list again without it")
}
