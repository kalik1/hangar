package guestfiles

import (
	"errors"
	"fmt"
	"math"
	"net/http"
	"strings"
	"time"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/kalik1/hangar/bridge/internal/agent"
	"github.com/kalik1/hangar/bridge/internal/apis/v1alpha1"
)

// fileError is an operation that the guest, or the bridge's checks, refused.
type fileError struct {
	// cause is one of v1alpha1's Cause* values.
	cause string
	// field is the parameter it is about, or the agent command.
	field   string
	message string
	// code overrides the cause's HTTP status.
	code int32
}

func (e *fileError) Error() string { return e.message }

func invalid(param, msg string) *fileError {
	return &fileError{cause: v1alpha1.CauseInvalid, field: param, message: msg}
}

func failed(cause, param, msg string) *fileError {
	return &fileError{cause: cause, field: param, message: msg}
}

// causeCodes are the HTTP status and the Status reason of each cause.
var causeCodes = map[string]struct {
	code   int32
	reason metav1.StatusReason
}{
	v1alpha1.CauseBlocked:            {http.StatusForbidden, metav1.StatusReasonForbidden},
	v1alpha1.CausePermissionDenied:   {http.StatusForbidden, metav1.StatusReasonForbidden},
	v1alpha1.CauseReadOnly:           {http.StatusForbidden, metav1.StatusReasonForbidden},
	v1alpha1.CauseNotFound:           {http.StatusNotFound, metav1.StatusReasonNotFound},
	v1alpha1.CauseAlreadyExists:      {http.StatusConflict, metav1.StatusReasonAlreadyExists},
	v1alpha1.CauseNotADirectory:      {http.StatusConflict, metav1.StatusReasonConflict},
	v1alpha1.CauseIsADirectory:       {http.StatusConflict, metav1.StatusReasonConflict},
	v1alpha1.CauseDirectoryNotEmpty:  {http.StatusConflict, metav1.StatusReasonConflict},
	v1alpha1.CauseNotARegularFile:    {http.StatusConflict, metav1.StatusReasonConflict},
	v1alpha1.CauseExpired:            {http.StatusGone, metav1.StatusReasonExpired},
	v1alpha1.CauseInvalid:            {http.StatusBadRequest, metav1.StatusReasonBadRequest},
	v1alpha1.CauseNoSpace:            {http.StatusInsufficientStorage, "InsufficientStorage"},
	v1alpha1.CauseNotSupported:       {http.StatusNotImplemented, "NotImplemented"},
	v1alpha1.CauseTimeout:            {http.StatusGatewayTimeout, metav1.StatusReasonTimeout},
	v1alpha1.CauseNotResponding:      {http.StatusServiceUnavailable, metav1.StatusReasonServiceUnavailable},
	v1alpha1.CauseNotConnected:       {http.StatusServiceUnavailable, metav1.StatusReasonServiceUnavailable},
	v1alpha1.CauseAgentError:         {http.StatusInternalServerError, metav1.StatusReasonInternalError},
	v1alpha1.CauseFailed:             {http.StatusInternalServerError, metav1.StatusReasonInternalError},
	v1alpha1.CauseTemporaryFileError: {http.StatusInternalServerError, metav1.StatusReasonInternalError},
}

// statusError returns err as the API error the call answers.
func statusError(err error) error {
	var fe *fileError
	if errors.As(err, &fe) {
		return newStatus(fe.cause, fe.field, fe.message, fe.code, 0)
	}
	var ae *agent.Error
	if errors.As(err, &ae) {
		retry := 0
		switch ae.Reason {
		case agent.NotConnected:
			retry = 5
		case agent.NotResponding:
			retry = int(agent.DefaultProbeInterval / time.Second)
		}
		return newStatus(agentCause(ae.Reason), ae.Command, ae.Message, 0, retry)
	}
	return agent.StatusError(err)
}

func agentCause(r agent.Reason) string {
	switch r {
	case agent.Blocked:
		return v1alpha1.CauseBlocked
	case agent.NotSupported:
		return v1alpha1.CauseNotSupported
	case agent.Timeout:
		return v1alpha1.CauseTimeout
	case agent.NotResponding:
		return v1alpha1.CauseNotResponding
	case agent.NotConnected:
		return v1alpha1.CauseNotConnected
	}
	return v1alpha1.CauseAgentError
}

func newStatus(cause, field, msg string, code int32, retryAfter int) *apierrors.StatusError {
	c, ok := causeCodes[cause]
	if !ok {
		c = causeCodes[v1alpha1.CauseFailed]
	}
	if code != 0 {
		c.code = code
	}
	st := metav1.Status{
		Status:  metav1.StatusFailure,
		Code:    c.code,
		Reason:  c.reason,
		Message: msg,
		Details: &metav1.StatusDetails{
			Group:  v1alpha1.GroupName,
			Kind:   v1alpha1.Resource + "/" + v1alpha1.SubresourceGuestFiles,
			Causes: []metav1.StatusCause{{Type: metav1.CauseType(cause), Message: msg, Field: field}},
		},
	}
	if retryAfter > 0 {
		st.Details.RetryAfterSeconds = int32(min(retryAfter, math.MaxInt32))
	}
	return &apierrors.StatusError{ErrStatus: st}
}

// errnoCauses read a guest's error message: strerror's words (glibc, musl
// and busybox say the same, in the C locale the scripts set), the shells'
// own, PowerShell's and Windows'.
var errnoCauses = []struct {
	text  string
	cause string
}{
	{"no such file", v1alpha1.CauseNotFound},
	{"directory nonexistent", v1alpha1.CauseNotFound},
	{"cannot find the file", v1alpha1.CauseNotFound},
	{"cannot find the path", v1alpha1.CauseNotFound},
	{"cannot find path", v1alpha1.CauseNotFound},
	{"does not exist", v1alpha1.CauseNotFound},
	{"permission denied", v1alpha1.CausePermissionDenied},
	{"operation not permitted", v1alpha1.CausePermissionDenied},
	{"access is denied", v1alpha1.CausePermissionDenied},
	{"access to the path", v1alpha1.CausePermissionDenied},
	{"read-only file system", v1alpha1.CauseReadOnly},
	{"file exists", v1alpha1.CauseAlreadyExists},
	{"cannot overwrite existing file", v1alpha1.CauseAlreadyExists},
	{"already exists", v1alpha1.CauseAlreadyExists},
	{"not a directory", v1alpha1.CauseNotADirectory},
	{"is a directory", v1alpha1.CauseIsADirectory},
	{"directory not empty", v1alpha1.CauseDirectoryNotEmpty},
	{"directory is not empty", v1alpha1.CauseDirectoryNotEmpty},
	{"no space left on device", v1alpha1.CauseNoSpace},
	{"disk quota exceeded", v1alpha1.CauseNoSpace},
	{"not enough space on the disk", v1alpha1.CauseNoSpace},
	{"subdirectory of itself", v1alpha1.CauseInvalid},
	{"invalid argument", v1alpha1.CauseInvalid},
	{"invalid user", v1alpha1.CauseInvalid},
	{"invalid group", v1alpha1.CauseInvalid},
	{"unknown user", v1alpha1.CauseInvalid},
	{"unknown group", v1alpha1.CauseInvalid},
}

// guestCause returns the cause a guest's error message names, or "".
func guestCause(msg string) string {
	lower := strings.ToLower(msg)
	for _, c := range errnoCauses {
		if strings.Contains(lower, c.text) {
			return c.cause
		}
	}
	return ""
}

// fileFailure turns an error of a guest-file-* call on path into the
// file's error where the agent's message names one (qemu-ga's "failed to
// open file '...' (mode: 'r'): Permission denied", say).
func fileFailure(err error, param, path string) error {
	var ae *agent.Error
	if !errors.As(err, &ae) || ae.Reason != agent.AgentError {
		return err
	}
	if cause := guestCause(ae.Message); cause != "" {
		return failed(cause, param, fmt.Sprintf("%s: %s", path, deniedHint(cause, ae.Message)))
	}
	return err
}

// deniedHint adds why a guest agent may be denied what root could do.
func deniedHint(cause, msg string) string {
	if cause != v1alpha1.CausePermissionDenied {
		return msg
	}
	return msg + " (the guest's permissions, or SELinux, which confines the guest agent on Fedora and the RHEL family " +
		"to /tmp and /var/tmp for writes unless the guest is changed to let it reach every file)"
}

// The exit statuses the bridge's scripts end with when they find what is
// wrong themselves; any other status is read from the error message.
const (
	exitNotFound      = 2
	exitDenied        = 13
	exitExists        = 17
	exitNotDir        = 20
	exitIsDir         = 21
	exitNotEmpty      = 39
	exitNotRegular    = 40
	exitRefused       = 64
	exitTemporaryFile = 75
	exitNoTool        = 127
)

var exitCauses = map[int]string{
	exitNotFound:      v1alpha1.CauseNotFound,
	exitDenied:        v1alpha1.CausePermissionDenied,
	exitExists:        v1alpha1.CauseAlreadyExists,
	exitNotDir:        v1alpha1.CauseNotADirectory,
	exitIsDir:         v1alpha1.CauseIsADirectory,
	exitNotEmpty:      v1alpha1.CauseDirectoryNotEmpty,
	exitNotRegular:    v1alpha1.CauseNotARegularFile,
	exitRefused:       v1alpha1.CauseInvalid,
	exitTemporaryFile: v1alpha1.CauseTemporaryFileError,
	exitNoTool:        v1alpha1.CauseNotSupported,
}

// scriptFailure is the error of a script that did not end with 0.
func scriptFailure(res *agent.ExecResult, param, what string) error {
	msg := strings.TrimSpace(string(res.Stderr))
	if msg == "" {
		msg = fmt.Sprintf("exit status %d", res.ExitCode)
	}
	if res.Signal != 0 {
		msg = fmt.Sprintf("ended by signal %d: %s", res.Signal, msg)
	}
	// The statuses no tool ends with say it all; the message comes before
	// the low ones, which a shell or a tool may end with for another reason
	// (dash ends a syntax error with 2).
	var cause string
	switch res.ExitCode {
	case exitNotRegular, exitRefused, exitTemporaryFile, exitNoTool:
		cause = exitCauses[res.ExitCode]
	}
	if cause == "" {
		cause = guestCause(msg)
	}
	if cause == "" {
		cause = exitCauses[res.ExitCode]
	}
	if cause == "" {
		cause = v1alpha1.CauseFailed
	}
	if cause == v1alpha1.CauseTemporaryFileError {
		msg = "the guest has no temporary file for the listing in " + guestTempDir + ": " + msg
	}
	return failed(cause, param, fmt.Sprintf("%s: %s", what, deniedHint(cause, oneLine(msg))))
}

func oneLine(s string) string {
	s = strings.TrimSpace(s)
	s = strings.ReplaceAll(s, "\r\n", "; ")
	return strings.ReplaceAll(s, "\n", "; ")
}
