package v1alpha1

import (
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// The guestfiles subresource: file operations in the guest, through the
// guest agent's guest-file-* and guest-exec commands.
//
//	GET    .../guestfiles?op=list&path=P[&cursor=C][&limit=N]    GuestFileList
//	GET    .../guestfiles?op=stat&path=P                         GuestFileInfo
//	GET    .../guestfiles?op=read&path=P[&offset=O][&length=L]   the bytes (application/octet-stream)
//	GET    .../guestfiles?op=hash&path=P                         GuestFileHash
//	PUT    .../guestfiles?op=write&path=P[&offset=O][&truncate=B] GuestFileWrite; the body is the bytes
//	POST   .../guestfiles?op=create&path=P[&exclusive=B]         GuestFileInfo (201)
//	POST   .../guestfiles?op=mkdir&path=P[&exclusive=B]          GuestFileInfo (201, or 200 when it was there)
//	POST   .../guestfiles?op=rename&from=P&to=Q[&exclusive=B]    GuestFileInfo of Q
//	POST   .../guestfiles?op=chown&path=P[&owner=U][&group=G]    GuestFileInfo (Linux)
//	DELETE .../guestfiles?op=delete&path=P[&recursive=B]         metav1.Status
//
// An error is a metav1.Status whose details.causes[0].reason is one of the
// Cause* values, and whose field is the parameter it is about or, for the
// agent's own errors, the agent command.

// The operations, the op parameter.
const (
	OpList   = "list"
	OpStat   = "stat"
	OpRead   = "read"
	OpHash   = "hash"
	OpWrite  = "write"
	OpCreate = "create"
	OpMkdir  = "mkdir"
	OpRename = "rename"
	OpChown  = "chown"
	OpDelete = "delete"
)

// The limits of guestfiles calls.
const (
	// MaxListLimit bounds the entries of one list page; it is also the
	// default.
	MaxListLimit = 5000
	// MaxReadLength bounds one read call; it is also the default. The bridge
	// reads it from the agent in 1 MiB guest-file-read calls.
	MaxReadLength = 3 << 20
	// MaxWriteBody bounds one write call's body (guest.MaxBodyBytes). The
	// bridge writes it to the agent in 128 KiB guest-file-write calls.
	MaxWriteBody = 1 << 20
)

// The headers of a read's answer.
const (
	// HeaderFileSize is the file's size in bytes when it was read.
	HeaderFileSize = "X-Hangar-File-Size"
	// HeaderFileMTime is the file's modification time (RFC 3339, UTC, with
	// the guest's precision), when the guest could tell it.
	HeaderFileMTime = "X-Hangar-File-Mtime"
	// HeaderFileOffset is the offset of the first byte of the answer.
	HeaderFileOffset = "X-Hangar-File-Offset"
	// HeaderFileEOF is "true" when the answer ends at the end of the file.
	HeaderFileEOF = "X-Hangar-File-Eof"
)

// The types of an entry.
const (
	FileTypeFile        = "file"
	FileTypeDirectory   = "directory"
	FileTypeSymlink     = "symlink"
	FileTypeBlockDevice = "blockDevice"
	FileTypeCharDevice  = "charDevice"
	FileTypeFIFO        = "fifo"
	FileTypeSocket      = "socket"
	FileTypeOther       = "other"
)

// GuestFile is one entry of a directory, or one file's stat.
type GuestFile struct {
	// Name is the entry's name, without its directory ("/" for the root).
	Name string `json:"name"`
	// Type is one of the FileType* values. A symbolic link is a symlink: it
	// is not followed.
	Type string `json:"type"`
	// Size is in bytes, as the guest reports it (a symlink's is the length
	// of its target, a directory's its own size).
	Size int64 `json:"size"`
	// Mode is the permission bits, setuid, setgid and sticky included
	// (0o7777 at most), on Linux. Windows has none.
	Mode *uint32 `json:"mode,omitempty"`
	// UID and GID are the owner's ids, on Linux.
	UID *int64 `json:"uid,omitempty"`
	GID *int64 `json:"gid,omitempty"`
	// User and Group are the owner's names, where the guest knows them
	// (GNU find; not busybox, not Windows).
	User  string `json:"user,omitempty"`
	Group string `json:"group,omitempty"`
	// MTime is the modification time, RFC 3339 in UTC with the guest's
	// precision (nanoseconds with GNU find, 100 ns on Windows, seconds or
	// minutes with busybox ls).
	MTime string `json:"mtime,omitempty"`
}

// GuestFileList is a page of a directory's entries (op=list).
type GuestFileList struct {
	metav1.TypeMeta `json:",inline"`
	// Entries are in the guest's order (readdir's with GNU find, by name
	// with busybox ls and on Windows).
	Entries []GuestFile `json:"entries"`
	// Cursor, when set, gets the next page: the same call with cursor=C.
	// A cursor that is too old answers 410 (CauseExpired): list again.
	Cursor string `json:"cursor,omitempty"`
	// Partial is true when the guest could not read some entries, which
	// the listing leaves out: SELinux confines the guest agent on Fedora and
	// the RHEL family, for example. Every page of the listing says it.
	Partial bool `json:"partial"`
	// PartialReason says why, for people.
	PartialReason string `json:"partialReason,omitempty"`
}

// GuestFileInfo is one file's entry: the answer of op=stat, and of the
// operations that change a file (of the file as it is after it). Its kind
// and apiVersion are fields of their own: metav1.TypeMeta's Size method
// would hide GuestFile's Size.
type GuestFileInfo struct {
	Kind       string `json:"kind"`
	APIVersion string `json:"apiVersion"`
	GuestFile
}

// GuestFileHash is a file's checksum (op=hash).
type GuestFileHash struct {
	metav1.TypeMeta `json:",inline"`
	// Algorithm is "sha256".
	Algorithm string `json:"algorithm"`
	// Hash is the lowercase hex digest.
	Hash string `json:"hash"`
	// Size and MTime are the file's when it was hashed.
	Size  int64  `json:"size"`
	MTime string `json:"mtime,omitempty"`
}

// GuestFileWrite is the answer of op=write.
type GuestFileWrite struct {
	metav1.TypeMeta `json:",inline"`
	// Written is the bytes written: the whole body.
	Written int64 `json:"written"`
	// Size is the file's size after the write.
	Size int64 `json:"size"`
}

// The causes of a guestfiles error: details.causes[0].reason of its Status.
const (
	// The guest agent's own states, as guestinfo reports them.
	CauseBlocked       = ReasonBlocked       // 403: the agent's configuration disables a command
	CauseNotSupported  = ReasonNotSupported  // 501: the agent or the guest has no way to do it
	CauseTimeout       = ReasonTimeout       // 504: no answer in time; a program may go on in the guest
	CauseAgentError    = ReasonAgentError    // 500: the agent failed
	CauseNotResponding = ReasonNotResponding // 503: restart the agent in the guest
	CauseNotConnected  = "NotConnected"      // 503: no agent on the VM's channel

	// What the guest said of the file.
	CauseNotFound           = "NotFound"           // 404
	CausePermissionDenied   = "PermissionDenied"   // 403: permissions, or SELinux confining the agent
	CauseReadOnly           = "ReadOnlyFileSystem" // 403
	CauseAlreadyExists      = "AlreadyExists"      // 409
	CauseNotADirectory      = "NotADirectory"      // 409
	CauseIsADirectory       = "IsADirectory"       // 409
	CauseDirectoryNotEmpty  = "DirectoryNotEmpty"  // 409
	CauseNotARegularFile    = "NotARegularFile"    // 409: a device, a FIFO or a socket
	CauseNoSpace            = "NoSpace"            // 507: no space, or over a quota
	CauseFailed             = "Failed"             // 500: the guest's command failed; the message says why
	CauseExpired            = "Expired"            // 410: the listing behind a cursor is gone
	CauseInvalid            = "Invalid"            // 400, or 409 for an offset past the end of a file
	CauseTemporaryFileError = "TemporaryFileError" // 500: no temporary file in the guest's /var/tmp
)
