package guestfiles

// The programs the bridge runs in the guest with guest-exec. Each is an
// untyped constant: agent.ShellScript and agent.PowerShellScript take
// nothing else, so no string a client sent becomes code. A client's values
// (paths, owners) reach them only as arguments: $1, $2... of /bin/sh, or the
// fields of $A in PowerShell, decoded from a base64 literal.
//
// Every script bounds what it prints far below the 2.9 MB a guest-exec-status
// reply may carry (over libvirt's 4 MiB RPC string the reply fails, over its
// 10 MiB agent limit the agent breaks): error messages are cut to 2 KiB,
// listings go to a temporary file above listInlineMax, and the rest prints
// one record.

// guestTempDir is where listings too long for one reply go: writable by the
// agent even where SELinux confines it.
const guestTempDir = "/var/tmp"

// findFormat is one entry as GNU find prints it: type, size, mtime (epoch
// seconds with a fraction), permission bits (octal), uid, gid, user, group
// and name, NUL-terminated. The name is last, so a tab in it stays its own.
const findFormat = `%y\t%s\t%T@\t%m\t%U\t%G\t%u\t%g\t%f\0`

// shPrelude starts every Linux script. It sets a known PATH, the C locale
// (error messages in English, which the bridge reads), UTC (busybox ls
// prints local times), and these functions:
//
//   - st PATH FOLLOW prints the tool ("find" or "ls") on a line, then PATH's
//     record, following a symbolic link when FOLLOW is 1;
//   - lsopts OPTS adds the option for full dates that this ls has
//     (--full-time, busybox's older -e, or none: minutes);
//   - lsu runs ls in a UTF-8 locale: in the C locale busybox ls prints "?"
//     for every byte of a name that is not ASCII. It prints "?" for a
//     control character (a tab, a newline) all the same;
//   - run CMD... runs CMD with its error messages cut to 2 KiB (the rest is
//     read and dropped, so CMD never dies of a closed pipe), and returns its
//     status;
//   - relabel PATH runs restorecon -R on PATH where SELinux is enabled: the
//     agent's new files otherwise keep their directory's type
//     (user_home_dir_t in a home, say).
const shPrelude = `PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
LC_ALL=C
TZ=UTC
export PATH LC_ALL TZ
umask 022
gnufind() { find / -maxdepth 0 -printf '' >/dev/null 2>&1; }
lsopts() {
	if ls -ldn --full-time / >/dev/null 2>&1; then echo "$1 --full-time"
	elif ls -ldne / >/dev/null 2>&1; then echo "${1}e"
	else echo "$1"; fi
}
lsu() { LC_ALL=C.UTF-8 ls "$@"; }
st() {
	if gnufind; then
		echo find
		if [ "$2" = 1 ]; then
			find -L "$1" -maxdepth 0 -printf '` + findFormat + `'
		else
			find -P "$1" -maxdepth 0 -printf '` + findFormat + `'
		fi
	else
		echo ls
		if [ "$2" = 1 ]; then lsu $(lsopts -ldLn) "$1"; else lsu $(lsopts -ldn) "$1"; fi
	fi
}
run() {
	{ rc=$( { { "$@" 2>&1 >&3 3>&- 4>&-; echo "$?" >&4; } | { head -c 2048 >&2; cat >/dev/null; }; } 4>&1 ); } 3>&1
	return "${rc:-1}"
}
relabel() {
	if command -v selinuxenabled >/dev/null 2>&1 && selinuxenabled && command -v restorecon >/dev/null 2>&1; then
		restorecon -R -- "$1" >/dev/null 2>&1
	fi
	return 0
}
`

// listScript lists directory $1: at most $2 entries and $3 bytes go in the
// reply, a longer listing stays in a temporary file of $4 that the bridge
// reads page by page with guest-file-read. GNU find where the guest has it
// (NUL-separated records), busybox ls otherwise (lines).
//
// It prints a header line, "hangar-ls TOOL STATUS COUNT BYTES ERRORS
// SELINUX FILE": the tool, its exit status, the entries and bytes it
// printed, its error lines, 1 when SELinux enforces, and the temporary
// file's name or "-" when the entries follow in the reply. Its error
// messages are cut to 2 KiB. Temporary files of listings older than 30
// minutes, which a client never finished, are removed.
const listScript = shPrelude + `d=$1 n=$2 max=$3 tmp=$4
find "$tmp" -maxdepth 1 -name 'hangar-ls.*' -mmin +30 -exec rm -f {} \; 2>/dev/null
if [ ! -d "$d" ] && { [ -e "$d" ] || [ -L "$d" ]; }; then
	echo "$d: Not a directory" >&2
	exit 20
fi
t=$(mktemp "$tmp/hangar-ls.XXXXXXXXXX") || exit 75
e=$(mktemp "$tmp/hangar-ls.XXXXXXXXXX") || { rm -f "$t"; exit 75; }
if gnufind; then
	tool=find
	find -H "$d" -mindepth 1 -maxdepth 1 -printf '` + findFormat + `' >"$t" 2>"$e"
	rc=$?
	count=$(tr -cd '\000' <"$t" | wc -c)
else
	tool=ls
	lsu $(lsopts -lAn) "$d/" >"$t" 2>"$e"
	rc=$?
	count=$(grep -vc '^total ' "$t")
fi
bytes=$(wc -c <"$t")
errs=$(wc -l <"$e")
se=0
if [ "$(cat /sys/fs/selinux/enforce 2>/dev/null)" = 1 ]; then se=1; fi
keep=-
if [ "$((count))" -gt "$((n))" ] || [ "$((bytes))" -gt "$((max))" ]; then keep=${t##*/}; fi
echo "hangar-ls $tool $rc $((count)) $((bytes)) $((errs)) $se $keep"
head -c 2048 "$e" >&2
rm -f "$e"
if [ "$keep" = - ]; then
	cat "$t"
	rm -f "$t"
fi
`

// listTempPattern is the name of a listing's temporary file, as mktemp
// makes it; the bridge removes no other file.
const listTempPattern = `^hangar-ls\.[A-Za-z0-9]{10}$`

// unlistScript removes the temporary file $2 of a listing from $1.
const unlistScript = `case $2 in
hangar-ls.[A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9])
	rm -f -- "$1/$2" ;;
*)
	exit 64 ;;
esac
`

// statScript prints $1's record, following a link when $2 is 1.
const statScript = shPrelude + `st "$1" "$2"
`

// hashScript prints the sha256 of regular file $1 on a line, then its
// record (followed).
const hashScript = shPrelude + `p=$1
if [ -d "$p" ]; then echo "$p: Is a directory" >&2; exit 21; fi
if [ -e "$p" ] && [ ! -f "$p" ]; then echo "$p: not a regular file" >&2; exit 40; fi
command -v sha256sum >/dev/null 2>&1 || { echo "the guest has no sha256sum" >&2; exit 127; }
h=$(sha256sum -- "$p") || exit 1
h=${h#\\}
printf '%.64s\n' "$h"
st "$p" 1
`

// mkdirScript makes directory $1, its parents too unless $2 (exclusive)
// is 1, relabels what it made, and prints "created" or "existed", then the
// directory's record.
const mkdirScript = shPrelude + `p=$1 x=$2
if [ "$x" != 1 ] && [ -d "$p" ]; then
	echo existed
	st "$p" 0
	exit
fi
top=$p
while :; do
	up=${top%/*}
	if [ -z "$up" ] || [ -d "$up" ]; then break; fi
	top=$up
done
if [ "$x" = 1 ]; then
	run mkdir -- "$p" || exit 1
else
	run mkdir -p -- "$p" || exit 1
fi
relabel "$top"
echo created
st "$p" 0
`

// createScript makes $1 an empty regular file: it fails if anything is
// there when $2 (exclusive) is 1, and empties a file that is there
// otherwise. It relabels it and prints its record.
const createScript = shPrelude + `p=$1 x=$2
if [ -d "$p" ]; then echo "$p: Is a directory" >&2; exit 21; fi
if [ -e "$p" ] || [ -L "$p" ]; then
	if [ "$x" = 1 ]; then echo "$p: File exists" >&2; exit 17; fi
	if [ ! -f "$p" ]; then echo "$p: not a regular file" >&2; exit 40; fi
fi
if [ "$x" = 1 ]; then
	run sh -c 'set -C; : >"$1"' sh "$p" || exit 1
else
	run sh -c ': >"$1"' sh "$p" || exit 1
fi
relabel "$p"
st "$p" 0
`

// renameScript renames $1 to $2. With $3 (exclusive) 1 it fails if $2 is
// there; otherwise it replaces a file or a link at $2, never a directory.
// It relabels $2 and prints its record.
const renameScript = shPrelude + `f=$1 t=$2 x=$3
run ls -d -- "$f" >/dev/null || exit 1
if [ -e "$t" ] || [ -L "$t" ]; then
	if [ "$x" = 1 ]; then echo "$t: File exists" >&2; exit 17; fi
	if [ -d "$t" ] && [ ! -L "$t" ]; then echo "$t: Is a directory" >&2; exit 21; fi
	if [ -d "$f" ] && [ ! -L "$f" ]; then echo "$t: Not a directory" >&2; exit 20; fi
	if [ -L "$t" ]; then run rm -f -- "$t" || exit 1; fi
fi
run mv -f -- "$f" "$t" || exit 1
relabel "$t"
st "$t" 0
`

// chownScript sets the owner of $1 (not following a link) to $2, which
// is OWNER, OWNER:GROUP or :GROUP, and prints its record.
const chownScript = shPrelude + `run chown -h -- "$2" "$1" || exit 1
st "$1" 0
`

// deleteScript prints $1's record, then deletes it: a file or a link, an
// empty directory, or with $2 (recursive) 1 a directory and everything in
// it. It never deletes /.
const deleteScript = shPrelude + `p=$1 r=$2
if [ "$p" = / ]; then echo "the bridge does not delete /" >&2; exit 64; fi
st "$p" 0 || exit 1
if [ -d "$p" ] && [ ! -L "$p" ]; then
	if [ "$r" = 1 ]; then
		run rm -rf -- "$p" || exit 1
	else
		run rmdir -- "$p" || exit 1
	fi
else
	run rm -f -- "$p" || exit 1
fi
`

// relabelScript relabels $1 where SELinux is enabled.
const relabelScript = shPrelude + `relabel "$1"
`

// psPrelude starts every Windows script, after the line that sets $A. It
// stops at the first error, writes UTF-8 to the standard output whatever
// the console's code page, and has these functions:
//
//   - Emit S writes S;
//   - Fail CODE MESSAGE writes MESSAGE (cut to 2 KiB) to the standard error
//     and exits with CODE;
//   - Code ERROR is the exit status of an error: 2 not found, 13 denied, 1
//     otherwise (the bridge then reads the message);
//   - Entry ITEM is an item's record: n name, y type (f, d or l), s size, m
//     mtime (UTC, round-trip format);
//   - ItemAt P is Get-Item of the literal path P, or Fail.
const psPrelude = `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$hangarOut = [Console]::OpenStandardOutput()
function Emit([string]$s) {
	$b = [Text.Encoding]::UTF8.GetBytes($s)
	$hangarOut.Write($b, 0, $b.Length)
	$hangarOut.Flush()
}
function Fail([int]$code, [string]$msg) {
	if ($msg.Length -gt 2048) { $msg = $msg.Substring(0, 2048) }
	[Console]::Error.Write($msg)
	exit $code
}
function Code($err) {
	foreach ($x in @($err.Exception, $err.Exception.InnerException)) {
		if ($x -is [System.Management.Automation.ItemNotFoundException] -or $x -is [System.IO.FileNotFoundException] -or $x -is [System.IO.DirectoryNotFoundException]) { return 2 }
		if ($x -is [System.UnauthorizedAccessException] -or $x -is [System.Security.SecurityException]) { return 13 }
	}
	return 1
}
function Entry($f) {
	$t = 'f'
	if ($f.Attributes -band [IO.FileAttributes]::ReparsePoint) { $t = 'l' } elseif ($f.PSIsContainer) { $t = 'd' }
	$s = [int64]0
	if (-not $f.PSIsContainer) { $s = [int64]$f.Length }
	[ordered]@{ n = [string]$f.Name; y = $t; s = $s; m = $f.LastWriteTimeUtc.ToString('o') }
}
function ItemAt([string]$p) {
	try { Get-Item -Force -LiteralPath $p } catch { Fail (Code $_) $_.Exception.Message }
}
function Json($o) { ConvertTo-Json -Compress -Depth 5 -InputObject $o }
`

// psListScript lists directory $A.path from entry $A.skip: at most
// $A.limit entries and about $A.max bytes. It prints {entries, next (the
// next entry's index, or null), errors (how many entries could not be
// read), error (the first message)}.
const psListScript = psPrelude + `$d = ItemAt $A.path
if (-not $d.PSIsContainer) { Fail 20 ($A.path + ': Not a directory') }
$ev = $null
$all = @(Get-ChildItem -Force -LiteralPath $A.path -ErrorAction SilentlyContinue -ErrorVariable ev)
$list = New-Object System.Collections.ArrayList
$bytes = 0
$i = [int]$A.skip
while ($i -lt $all.Count -and $list.Count -lt [int]$A.limit) {
	$e = Entry $all[$i]
	$bytes += 3 * $e.n.Length + 96
	if ($list.Count -gt 0 -and $bytes -gt [int]$A.max) { break }
	[void]$list.Add($e)
	$i++
}
$next = $null
if ($i -lt $all.Count) { $next = $i }
$errs = 0
$first = ''
if ($ev) {
	$errs = $ev.Count
	$first = [string]$ev[0].Exception.Message
	if ($first.Length -gt 1024) { $first = $first.Substring(0, 1024) }
}
Emit (Json ([ordered]@{ entries = @($list.ToArray()); next = $next; errors = $errs; error = $first }))
`

// psStatScript prints $A.path's record.
const psStatScript = psPrelude + `Emit (Json (Entry (ItemAt $A.path)))
`

// psHashScript prints the record of file $A.path with h, its sha256.
const psHashScript = psPrelude + `$f = ItemAt $A.path
if ($f.PSIsContainer) { Fail 21 ($A.path + ': Is a directory') }
try { $h = (Get-FileHash -Algorithm SHA256 -LiteralPath $A.path).Hash.ToLowerInvariant() } catch { Fail (Code $_) $_.Exception.Message }
$e = Entry $f
$e['h'] = $h
Emit (Json $e)
`

// psMkdirScript makes directory $A.path and its parents ($A.exclusive: it
// must not be there), and prints {created, entry}.
const psMkdirScript = psPrelude + `$p = $A.path
if (Test-Path -LiteralPath $p) {
	$f = ItemAt $p
	if ($A.exclusive -or -not $f.PSIsContainer) { Fail 17 ($p + ': File exists') }
	Emit (Json ([ordered]@{ created = $false; entry = (Entry $f) }))
	exit 0
}
try { $null = [IO.Directory]::CreateDirectory($p) } catch { Fail (Code $_) $_.Exception.Message }
Emit (Json ([ordered]@{ created = $true; entry = (Entry (ItemAt $p)) }))
`

// psCreateScript makes $A.path an empty file ($A.exclusive: nothing may be
// there; otherwise a file there is emptied), and prints its record.
const psCreateScript = psPrelude + `$p = $A.path
if (Test-Path -LiteralPath $p -PathType Container) { Fail 21 ($p + ': Is a directory') }
$mode = [IO.FileMode]::Create
if ($A.exclusive) { $mode = [IO.FileMode]::CreateNew }
try { ([IO.File]::Open($p, $mode, [IO.FileAccess]::Write)).Dispose() } catch { Fail (Code $_) $_.Exception.Message }
Emit (Json (Entry (ItemAt $p)))
`

// psRenameScript renames $A.from to $A.to ($A.exclusive: $A.to must not
// be there; otherwise a file there is replaced, never a directory), and
// prints the record of $A.to.
const psRenameScript = psPrelude + `$f = ItemAt $A.from
$t = $A.to
if (Test-Path -LiteralPath $t) {
	if ($A.exclusive) { Fail 17 ($t + ': File exists') }
	if ((ItemAt $t).PSIsContainer) { Fail 21 ($t + ': Is a directory') }
	if ($f.PSIsContainer) { Fail 20 ($t + ': Not a directory') }
	try { [IO.File]::Delete($t) } catch { Fail (Code $_) $_.Exception.Message }
}
try {
	if ($f.PSIsContainer) { [IO.Directory]::Move($A.from, $t) } else { [IO.File]::Move($A.from, $t) }
} catch { Fail (Code $_) $_.Exception.Message }
Emit (Json (Entry (ItemAt $t)))
`

// psDeleteScript prints the record of $A.path, then deletes it: a file, a
// link, an empty directory, or with $A.recursive a directory and everything
// in it. A link to a directory (a junction) is removed, never followed.
const psDeleteScript = psPrelude + `$p = $A.path
$f = ItemAt $p
$e = Entry $f
try {
	if ($f.PSIsContainer -and ($f.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
		[IO.Directory]::Delete($p, $false)
	} elseif ($f.PSIsContainer) {
		if (-not $A.recursive -and @(Get-ChildItem -Force -LiteralPath $p | Select-Object -First 1).Count -gt 0) { Fail 39 ($p + ': Directory not empty') }
		Remove-Item -Force -Recurse -LiteralPath $p
	} else {
		Remove-Item -Force -LiteralPath $p
	}
} catch { Fail (Code $_) $_.Exception.Message }
Emit (Json $e)
`
