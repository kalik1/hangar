/*
 * A VM's Files tab (hangar#6): the VM's folders next to a folder of this
 * PC, through Hangar's guest bridge (guestfiles) and the browser's File
 * System Access API (Chromium; Electron). Copies both ways by buttons or
 * drag and drop, files dropped from this PC's file manager, new folder,
 * rename, delete, properties with the SHA-256, "Edit on this PC" with the
 * write-back and its conflict check. Firefox and Safari get the VM pane
 * with upload, download and "Replace with a local file".
 *
 * The tab shows only what the guest agent reaches. On Fedora and the RHEL
 * family SELinux confines it: a partial listing says so, a denied write
 * outside /tmp and /var/tmp says why, and the tab shows the guest-side
 * change (and its revert) that lets the agent reach every file. Commands
 * the guest blocks (RHEL's allow-list) come with the two ways to enable
 * them. The user needs hangar-guest-admin on this VM (a review that names
 * it, so resourceNames bindings count).
 */

import { Icon } from '@iconify/react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import FormControlLabel from '@mui/material/FormControlLabel';
import LinearProgress from '@mui/material/LinearProgress';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import TextField from '@mui/material/TextField';
import React from 'react';
import { useHangar } from '../../api/data';
import { edits, EditSession } from '../../api/editing';
import { useGuestBridge } from '../../api/guest';
import { bridgeChannel, FileChannel, FilePerms, GuestFileError, toFileError, useFilePerms } from '../../api/guestfiles';
import { blobSource, downloadSink, fsaDir, fsaSupported, handleSink, loadRootHandle, LocalDir, LocalFileHandle, pickDirectory, pickSaveFile, savePickerSupported, saveRootHandle, Sink } from '../../api/localfs';
import {
  downloadFile,
  knownVersion,
  Plan,
  planDownload,
  planUpload,
  rememberVersion,
  runAsTask,
  runDownload,
  RunResult,
  runUpload,
  transfersRunning,
  UploadItem,
  vmCopyState,
} from '../../api/transfer';
import {
  agentReach,
  blockedFileCommands,
  channelTime,
  ConflictPolicy,
  crumbs,
  errorText,
  FILE_COMMANDS,
  fileRoots,
  filterEntries,
  fullAccessFor,
  GuestFile,
  GuestFileList,
  GUESTFILES_ROLE,
  isDir,
  joinPath,
  keepBothName,
  LARGE_FILE_BYTES,
  nameProblem,
  namesText,
  normalizePath,
  ownerProblem,
  parentPath,
  parseOwner,
  rootOf,
  sortEntries,
  SortKey,
} from '../../model/guestfiles';
import { blockedFix, guestOsId, installHint, isWindowsId, restartLine } from '../../model/guestinfo';
import { Obj } from '../../model/types';
import { formatBytes } from '../../model/units';
import { key } from '../../model/vm';
import { confirm } from '../../ui/dialogs';
import { Empty, Panel, Toolbar,ToolButton } from '../../ui/kit';
import { tabular } from '../../ui/tokens';
import { useTokens } from '../../ui/useTokens';
import { vmOs } from '../os';
import { askConflict, askEditConflict, FileList, FullAccessPanel, PaneTitle, PartialNote, promptName, ReachNote, showProperties } from './filesParts';
import { AgentNotResponding, BlockedFixBody, BridgeNotice, InstallAgent, Note } from './guestParts';

const VM_DRAG = 'application/x-hangar-vm-files';
const PC_DRAG = 'application/x-hangar-pc-files';

type Tone = 'error' | 'warn' | undefined;
type Notice = { tone: Tone; text: string } | null;
type OwnerMode = 'agent' | 'folder' | 'custom';

/** The names a pane's drag carries (a drag from elsewhere may carry anything). */
function dragNames(data: string): string[] {
  try {
    const v = JSON.parse(data || '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/* ------------------------------------------------- leaving the page */

let guarded = false;
/** Leaving the page cuts copies and ends editing: ask first while either is busy. */
function guardUnload() {
  if (guarded || typeof window === 'undefined') return;
  guarded = true;
  window.addEventListener('beforeunload', e => {
    if (!transfersRunning() && !edits.unsaved()) return;
    e.preventDefault();
    e.returnValue = '';
  });
}

/* -------------------------------------------------------------- the tab */

export function FilesTab({ vm }: { vm: Obj }) {
  const d = useHangar();
  const vmi = d.idx.vmi.get(key(vm));
  const ns = vm.metadata.namespace as string;
  const name = vm.metadata.name as string;
  const running = vmi?.status?.phase === 'Running' && !!vmi?.status?.nodeName;
  const { state: bridge } = useGuestBridge({ namespace: ns, name, running, sections: ['system', 'disks'] });
  const perms = useFilePerms(ns, name);
  const info = bridge.kind === 'ok' ? bridge.info : undefined;
  const osId = guestOsId(info, null, vmi, vmOs(vm, d).id);
  const win = isWindowsId(osId);
  React.useEffect(guardUnload, []);

  if (!vmi || !running)
    return (
      <Empty icon="mdi:power-plug-off-outline" title={vmi ? 'The VM is not running' : 'The VM is powered off'}>
        Its files are reachable through the guest agent while it runs.
      </Empty>
    );
  if (bridge.kind === 'absent')
    return (
      <Empty icon="mdi:puzzle-outline" title="Needs Hangar’s guest bridge">
        This cluster does not have it. The guest bridge reaches the VM’s files through the QEMU guest agent; k4all installs it with the virtualization component.
      </Empty>
    );
  if (perms.loading) return <Note icon="mdi:timer-sand">Checking your role…</Note>;
  if (!perms.get)
    return (
      <Empty icon="mdi:lock-outline" title="Your role does not reach this VM’s files">
        It needs get, create, update and delete on virtualmachineinstances/guestfiles (subresources.hangar.magesgate.com), which the role {GUESTFILES_ROLE} grants. Bind it
        in this folder with a RoleBinding, or for this VM only with a Role of your own that names it in resourceNames.
      </Empty>
    );
  if (info && !info.agent.connected)
    return (
      <Box sx={{ display: 'grid', gap: 1.5 }}>
        <Note icon="mdi:link-variant-off" tone="warn">
          The guest agent is not connected{info.agent.message ? `: ${info.agent.message}` : '.'} The Files tab needs it.
        </Note>
        <InstallAgent hint={installHint(osId)} />
      </Box>
    );
  return (
    <FilesBody
      // Paths change form when the guest turns out to be Windows.
      key={win ? 'windows' : 'linux'}
      vm={{ namespace: ns, name }}
      osId={osId}
      win={win}
      perms={perms}
      roots={fileRoots(info?.disks?.filesystems, win)}
      commands={info?.agent.commands}
      notResponding={info ? !info.agent.healthy : false}
      agentMessage={info?.agent.message}
      bridgeNote={bridge.kind !== 'ok' && bridge.kind !== 'forbidden' && bridge.kind !== 'loading' ? <BridgeNotice state={bridge} /> : null}
    />
  );
}

/* -------------------------------------------------------------- panes */

function useVmDir(ch: FileChannel, start: string, onListed: (l: GuestFileList) => void, onFail: (e: GuestFileError, path: string) => void) {
  const [path, setPath] = React.useState(start);
  const [listing, setListing] = React.useState<GuestFileList | null>(null);
  const [error, setError] = React.useState<GuestFileError | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [tick, setTick] = React.useState(0);
  const cb = React.useRef({ onListed, onFail });
  cb.current = { onListed, onFail };
  React.useEffect(() => {
    const ctl = new AbortController();
    setLoading(true);
    ch.list(path, ctl.signal).then(
      l => {
        if (ctl.signal.aborted) return;
        setListing(l);
        setError(null);
        setLoading(false);
        cb.current.onListed(l);
      },
      e => {
        if (ctl.signal.aborted) return;
        const fe = toFileError(e);
        setError(fe);
        setListing(null);
        setLoading(false);
        cb.current.onFail(fe, path);
      }
    );
    return () => ctl.abort();
  }, [ch, path, tick]);
  const refresh = React.useCallback(() => setTick(t => t + 1), []);
  return { path, go: (p: string) => setPath(normalizePath(p, ch.windows)), refresh, listing, error, loading };
}

function useLocalDir(enabled: boolean) {
  const [stack, setStack] = React.useState<LocalDir[]>([]);
  const [saved, setSaved] = React.useState<LocalDir | null>(null);
  const [entries, setEntries] = React.useState<GuestFile[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [tick, setTick] = React.useState(0);
  const cur = stack[stack.length - 1] ?? null;
  React.useEffect(() => {
    if (!enabled) return;
    let alive = true;
    loadRootHandle().then(async h => {
      if (!alive || !h) return;
      const dir = fsaDir(h);
      if ((await dir.permission().catch(() => 'prompt')) === 'granted') setStack([dir]);
      else setSaved(dir);
    });
    return () => {
      alive = false;
    };
  }, [enabled]);
  React.useEffect(() => {
    if (!cur) return;
    let alive = true;
    cur.list().then(
      l => alive && (setEntries(l), setError(null)),
      e => alive && setError(String(e?.message ?? e))
    );
    return () => {
      alive = false;
    };
  }, [cur, tick]);
  return {
    cur,
    saved,
    entries,
    error,
    path: stack.map(s => s.name),
    refresh: () => setTick(t => t + 1),
    async pick() {
      const h = await pickDirectory();
      if (!h) return;
      await saveRootHandle(h);
      setSaved(null);
      setStack([fsaDir(h)]);
    },
    async reopen() {
      if (saved && (await saved.requestPermission())) {
        setStack([saved]);
        setSaved(null);
      }
    },
    async into(name: string) {
      if (!cur) return;
      const next = await cur.dir(name, false);
      setStack(s => [...s, next]);
    },
    to(depth: number) {
      setStack(s => s.slice(0, depth + 1));
    },
  };
}

/* --------------------------------------------------------------- body */

interface BodyProps {
  vm: { namespace: string; name: string };
  osId: string;
  win: boolean;
  perms: FilePerms;
  roots: string[];
  commands?: { name: string; enabled: boolean }[];
  notResponding: boolean;
  agentMessage?: string;
  bridgeNote: React.ReactNode;
}

function FilesBody({ vm, osId, win, perms, roots, commands, notResponding, agentMessage, bridgeNote }: BodyProps) {
  const t = useTokens();
  const ch = React.useMemo(() => bridgeChannel(vm.namespace, vm.name, win), [vm.namespace, vm.name, win]);
  const vmKey = `${vm.namespace}/${vm.name}`;
  const reach = agentReach(osId);
  const fsa = fsaSupported();
  const [notice, setNotice] = React.useState<Notice>(null);
  const [blocked, setBlocked] = React.useState<string[]>([]);
  const [evidence, setEvidence] = React.useState(false);
  const [faOpen, setFaOpen] = React.useState(false);
  const [verify, setVerify] = React.useState(false);
  const [ownerMode, setOwnerMode] = React.useState<OwnerMode>('folder');
  const [ownerText, setOwnerText] = React.useState('');

  const fail = React.useCallback(
    (e: GuestFileError, path?: string) => {
      if (e.reason === 'Cancelled') return;
      if (e.reason === 'Blocked') setBlocked(e.commands?.length ? e.commands : FILE_COMMANDS);
      if (e.reason === 'PermissionDenied' && (reach === 'confined' || /selinux/i.test(e.message))) {
        setEvidence(true);
        if (path && !win) setFaOpen(true);
      }
      setNotice({ tone: 'error', text: errorText(e, { path, osId }) });
    },
    [reach, osId, win]
  );

  const vmDir = useVmDir(
    ch,
    roots[0],
    l => {
      // A listing that works: what the guest blocked before is enabled now.
      setBlocked([]);
      if (l.partial) setEvidence(true);
    },
    (e, p) => fail(e, p)
  );
  const local = useLocalDir(fsa);
  const [vmSel, setVmSel] = React.useState<Set<string>>(new Set());
  const [pcSel, setPcSel] = React.useState<Set<string>>(new Set());
  const [vmSort, setVmSort] = React.useState<{ key: SortKey; desc: boolean }>({ key: 'name', desc: false });
  const [pcSort, setPcSort] = React.useState<{ key: SortKey; desc: boolean }>({ key: 'name', desc: false });
  const [vmFilter, setVmFilter] = React.useState('');
  const [pcFilter, setPcFilter] = React.useState('');
  React.useEffect(() => setVmSel(new Set()), [vmDir.path]);
  React.useEffect(() => setPcSel(new Set()), [local.cur]);

  const vmEntries = vmDir.listing?.entries ?? [];
  const vmShown = sortEntries(filterEntries(vmEntries, vmFilter), vmSort.key, vmSort.desc);
  const pcEntries = local.entries ?? [];
  const pcShown = sortEntries(filterEntries(pcEntries, pcFilter), pcSort.key, pcSort.desc);
  const picked = vmEntries.filter(e => vmSel.has(e.name));
  const one = picked.length === 1 ? picked[0] : undefined;
  const vmPath = (n: string) => joinPath(vmDir.path, n, win);

  const allBlocked = [...new Set([...blockedFileCommands(commands), ...blocked])];
  const fix = blockedFix(osId, allBlocked);
  const fa = fullAccessFor(osId, evidence);

  /* ---------------------------------------------------------- helpers */

  const largeOk = async (bytes: number, up: boolean, inMemory = false) => {
    if (bytes <= LARGE_FILE_BYTES) return true;
    return !!(await confirm({
      title: 'A large copy through the guest agent',
      body: (
        <>
          <p>
            {formatBytes(bytes)} take about {channelTime(bytes, up)} through the guest agent, which moves about 13 MB/s up and 19 MB/s down; the VM’s agent is busy
            meanwhile.{inMemory ? ' This browser keeps the whole download in memory until it ends.' : ''}
          </p>
          <p>For a disk image, upload it as a disk in Storage instead.</p>
        </>
      ),
      confirm: 'Copy anyway',
    }));
  };

  const owner = async (dir: string) => {
    if (win || ownerMode === 'agent') return undefined;
    if (ownerMode === 'custom') return ownerText.trim() ? parseOwner(ownerText) : undefined;
    const st = await ch.stat(dir).catch(() => null);
    if (!st || (st.uid === 0 && (st.gid ?? 0) === 0) || st.uid === undefined) return undefined;
    return { owner: st.user || String(st.uid), group: st.group || (st.gid !== undefined ? String(st.gid) : undefined) };
  };

  const summary = (r: RunResult, plan: Plan<unknown>, what: string) => {
    const denied = r.failed.find(f => f.error.reason === 'PermissionDenied');
    if (denied) fail(new GuestFileError(denied.error), denied.path);
    const extra = [
      plan.skipped ? `${plan.skipped} skipped` : '',
      plan.partial.length ? `${plan.partial.length} folder${plan.partial.length === 1 ? ' was' : 's were'} listed partially (SELinux): what the agent cannot see was not copied` : '',
    ].filter(Boolean);
    if (r.failed.length) {
      const f = r.failed[0];
      return {
        status: r.done ? ('warning' as const) : ('failed' as const),
        message: `${r.failed.length} of ${r.failed.length + r.done} failed: ${errorText(f.error, { path: f.path, osId })}`,
      };
    }
    return {
      status: plan.partial.length ? ('warning' as const) : ('done' as const),
      message: [`${r.done} ${r.done === 1 ? 'item' : 'items'} ${what}, ${formatBytes(r.bytes)}${verify ? ', SHA-256 checked' : ''}`, ...extra].join('; '),
    };
  };

  /** A task body that tells the tab about a failure that stopped the copy. */
  const watch = async <T,>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      fail(toFileError(e));
      throw e;
    }
  };

  /* ---------------------------------------------------------- copies */

  const copyToVm = async (items: UploadItem[]) => {
    if (!items.length) return;
    setNotice(null);
    const dir = vmDir.path;
    let plan: Plan<any>;
    try {
      const existing = vmDir.listing?.entries ?? (await ch.list(dir)).entries;
      plan = await planUpload(ch, items, dir, existing, new ConflictPolicy(askConflict));
    } catch (e) {
      fail(toFileError(e), dir);
      return;
    }
    if (!plan.steps.length) return setNotice({ tone: undefined, text: 'Nothing to copy: every item was skipped.' });
    if (ownerMode === 'custom' && !win && ownerText.trim() && ownerProblem(ownerText))
      return setNotice({ tone: 'error', text: `The owner “${ownerText}” is not one Hangar can set: type user, user:group or :group.` });
    if (!(await largeOk(plan.bytes, true))) return;
    const own = await owner(dir);
    const title = items.length === 1 ? `Upload ${items[0].name}` : `Upload ${items.length} items`;
    await runAsTask(vm, title, ctx =>
      watch(async () => {
        const r = await runUpload(ch, plan, {
          signal: ctx.signal,
          verify,
          owner: own,
          onProgress: (done, cur) => ctx.progress(done, plan.bytes, cur),
          onVersion: (p, v) => rememberVersion(vmKey, p, v),
        });
        return summary(r, plan, 'copied to the VM');
      })
    );
    vmDir.refresh();
  };

  const copyToPc = async (entries: GuestFile[]) => {
    const target = local.cur;
    if (!target || !entries.length) return;
    setNotice(null);
    let plan: Plan<any>;
    try {
      plan = await planDownload(ch, entries, vmDir.path, target, new ConflictPolicy(askConflict));
    } catch (e) {
      fail(toFileError(e), vmDir.path);
      return;
    }
    if (!plan.steps.length) return setNotice({ tone: undefined, text: 'Nothing to copy: every item was skipped.' });
    if (!(await largeOk(plan.bytes, false))) return;
    const title = entries.length === 1 ? `Download ${entries[0].name}` : `Download ${entries.length} items`;
    await runAsTask(vm, title, ctx =>
      watch(async () => {
        const r = await runDownload(ch, plan, target, {
          signal: ctx.signal,
          verify,
          onProgress: (done, cur) => ctx.progress(done, plan.bytes, cur),
          onVersion: (p, v) => rememberVersion(vmKey, p, v),
        });
        return summary(r, plan, 'copied to this PC');
      })
    );
    local.refresh();
  };

  /** Without a local folder: a save dialog for one file where the browser has it, else plain browser downloads. */
  const downloadPlain = async (entries: GuestFile[]) => {
    const files = entries.filter(e => e.type === 'file' || e.type === 'symlink');
    if (files.length < entries.length) setNotice({ tone: 'warn', text: 'Folders are copied only to a folder of this PC (the dual view of Chrome, Edge and Opera): pick files.' });
    if (!files.length) return;
    let sinks: Sink[];
    const total = files.reduce((n, f) => n + f.size, 0);
    if (files.length === 1 && savePickerSupported()) {
      // The picker first, while the click still counts as the user's.
      const h = await pickSaveFile(files[0].name);
      if (!h || !(await largeOk(total, false))) return;
      sinks = [await handleSink(h)];
    } else {
      if (!(await largeOk(total, false, true))) return;
      sinks = files.map(f => downloadSink(f.name));
    }
    await runAsTask(vm, files.length === 1 ? `Download ${files[0].name}` : `Download ${files.length} files`, ctx =>
      watch(async () => {
        let done = 0;
        for (let i = 0; i < files.length; i++) {
          const p = vmPath(files[i].name);
          const base = done;
          const r = await downloadFile(ch, p, sinks[i], { signal: ctx.signal, verify, onBytes: n => ctx.progress(base + n, total, p) });
          rememberVersion(vmKey, p, { size: r.size, mtime: r.mtime, sha256: r.sha256 });
          done += r.size;
        }
        return { status: 'done' as const, message: `${files.length} ${files.length === 1 ? 'file' : 'files'}, ${formatBytes(done)}${verify ? ', SHA-256 checked' : ''}` };
      })
    );
  };

  const download = (entries: GuestFile[]) => (fsa && local.cur ? copyToPc(entries) : downloadPlain(entries));

  const uploadFiles = (files: File[]) => copyToVm(files.map(f => ({ kind: 'file' as const, name: f.name, source: blobSource(f) })));

  const copySelectedToVm = async (names: string[]) => {
    const dir = local.cur;
    if (!dir) return;
    const items: UploadItem[] = [];
    for (const n of names) {
      const e = pcEntries.find(x => x.name === n);
      if (!e) continue;
      items.push(isDir(e) ? { kind: 'dir', name: n, dir: await dir.dir(n, false) } : { kind: 'file', name: n, source: await dir.source(n) });
    }
    await copyToVm(items);
  };

  /* ------------------------------------------------- edit and replace */

  const editOnPc = async (e: GuestFile) => {
    let handle: LocalFileHandle | null = null;
    let folder: string | undefined;
    if (local.cur) {
      const there = await local.cur.list();
      const ex = there.find(x => x.name === e.name);
      let n = e.name;
      if (ex) {
        const a = await askConflict({ name: n, where: 'this PC', existing: ex, incoming: e, choices: isDir(ex) ? ['keepBoth'] : ['replace', 'keepBoth'] });
        if (!a || a.choice === 'skip') return;
        if (a.choice === 'keepBoth') n = keepBothName(n, x => there.some(y => y.name === x));
      }
      handle = await local.cur.handle(n);
      folder = local.path.join('/');
    } else {
      handle = await pickSaveFile(e.name);
    }
    if (!handle) return;
    if (!(await largeOk(e.size, false))) return;
    await edits.start(ch, vm, vmPath(e.name), handle, folder);
    local.refresh();
  };

  const replaceInput = React.useRef<HTMLInputElement>(null);
  const replaceTarget = React.useRef<GuestFile | null>(null);
  const replaceWith = async (file: File) => {
    const e = replaceTarget.current;
    if (!e) return;
    const path = vmPath(e.name);
    const base = knownVersion(vmKey, path);
    let target = path;
    let mode: 'replace' | 'new' = 'replace';
    try {
      const state = base ? await vmCopyState(ch, path, base) : 'unknown';
      if (state === 'changed') {
        const c = await askEditConflict(e.name, file.name);
        if (!c || c === 'keepVm') return;
        if (c === 'saveBoth') {
          target = vmPath(keepBothName(e.name, n => vmEntries.some(x => x.name === n)));
          mode = 'new';
        }
      } else if (state === 'unknown') {
        const ok = await confirm({
          title: `Replace ${e.name}?`,
          body: `Hangar did not read ${e.name} in this page, so it cannot tell whether the VM’s copy changed since you got it. The VM’s copy (${formatBytes(e.size)}) is replaced with ${file.name} (${formatBytes(file.size)}).`,
          confirm: 'Replace',
        });
        if (!ok) return;
      }
    } catch (err) {
      fail(toFileError(err), path);
      return;
    }
    if (!(await largeOk(file.size, true))) return;
    const plan: Plan<any> = { steps: [{ op: 'upload', path: target, source: blobSource(file, file.name), mode, created: mode === 'new' }], bytes: file.size, skipped: 0, partial: [] };
    await runAsTask(vm, `Replace ${e.name}`, ctx =>
      watch(async () => summary(await runUpload(ch, plan, { signal: ctx.signal, verify, onProgress: d => ctx.progress(d, file.size, target), onVersion: (p, v) => rememberVersion(vmKey, p, v) }), plan, 'written to the VM'))
    );
    vmDir.refresh();
  };

  /* -------------------------------------------- folder, rename, delete */

  const newVmFolder = async () => {
    const n = await promptName({ title: `New folder in ${vmDir.path}`, confirm: 'Create', check: s => nameProblem(s, win) ?? (vmEntries.some(e => e.name === s) ? 'This name is taken.' : null) });
    if (!n) return;
    try {
      await ch.mkdir(vmPath(n), true);
    } catch (e) {
      fail(toFileError(e), vmPath(n));
    }
    vmDir.refresh();
  };

  const renameVm = async (e: GuestFile) => {
    const n = await promptName({ title: `Rename ${e.name}`, confirm: 'Rename', initial: e.name, check: s => nameProblem(s, win) ?? (vmEntries.some(x => x.name === s) ? 'This name is taken.' : null) });
    if (!n) return;
    try {
      await ch.rename(vmPath(e.name), vmPath(n), true);
    } catch (err) {
      fail(toFileError(err), vmPath(n));
    }
    vmDir.refresh();
  };

  const deleteBody = (list: GuestFile[], where: string) => (
    <>
      <p>
        {where}: {namesText(list.map(e => e.name), 6)}.
      </p>
      {list.some(isDir) && <p>Folders go with everything in them.</p>}
      <p>This cannot be undone.</p>
    </>
  );

  const deleteVm = async (list: GuestFile[]) => {
    const ok = await confirm({ title: `Delete ${list.length === 1 ? list[0].name : `${list.length} items`}?`, body: deleteBody(list, `In the VM, ${vmDir.path}`), confirm: 'Delete', danger: true });
    if (!ok) return;
    for (const e of list) {
      try {
        await ch.remove(vmPath(e.name), isDir(e));
      } catch (err) {
        fail(toFileError(err), vmPath(e.name));
        break;
      }
    }
    vmDir.refresh();
  };

  const newPcFolder = async () => {
    const dir = local.cur;
    if (!dir) return;
    const n = await promptName({ title: `New folder in ${local.path.join('/')}`, confirm: 'Create', check: s => nameProblem(s, true) ?? (pcEntries.some(e => e.name === s) ? 'This name is taken.' : null) });
    if (!n) return;
    await dir.dir(n, true).catch(e => setNotice({ tone: 'error', text: String(e?.message ?? e) }));
    local.refresh();
  };

  const deletePc = async (list: GuestFile[]) => {
    const dir = local.cur;
    if (!dir) return;
    const ok = await confirm({ title: `Delete ${list.length === 1 ? list[0].name : `${list.length} items`}?`, body: deleteBody(list, `On this PC, ${local.path.join('/')}`), confirm: 'Delete', danger: true });
    if (!ok) return;
    for (const e of list) await dir.remove(e.name, true).catch(err => setNotice({ tone: 'error', text: String(err?.message ?? err) }));
    local.refresh();
  };

  /* -------------------------------------------------------- drag, drop */

  const [dropOn, setDropOn] = React.useState<'vm' | 'pc' | null>(null);
  const dropProps = (pane: 'vm' | 'pc') => ({
    onDragOver: (ev: React.DragEvent) => {
      const types = Array.from(ev.dataTransfer?.types ?? []);
      const ok = pane === 'vm' ? perms.update && (types.includes(PC_DRAG) || types.includes('Files')) : types.includes(VM_DRAG) && !!local.cur;
      if (!ok) return;
      ev.preventDefault();
      ev.dataTransfer.dropEffect = 'copy';
      setDropOn(pane);
    },
    onDragLeave: () => setDropOn(null),
    onDrop: (ev: React.DragEvent) => {
      ev.preventDefault();
      setDropOn(null);
      if (pane === 'pc') {
        const names = dragNames(ev.dataTransfer.getData(VM_DRAG));
        void copyToPc(vmEntries.filter(e => names.includes(e.name)));
        return;
      }
      const own = ev.dataTransfer.getData(PC_DRAG);
      if (own) return void copySelectedToVm(dragNames(own));
      // From this PC's file manager: files only (a dropped folder has no bytes to read).
      const items = Array.from(ev.dataTransfer.items ?? []);
      const folders = items.filter(i => (i as any).webkitGetAsEntry?.()?.isDirectory).length;
      const files = Array.from(ev.dataTransfer.files ?? []).filter((_, i) => !(items[i] as any)?.webkitGetAsEntry?.()?.isDirectory);
      if (folders) setNotice({ tone: 'warn', text: 'Folders dropped from the file manager are not copied: open their parent in the PC pane and copy them from there.' });
      void uploadFiles(files);
    },
  });

  /* ------------------------------------------------------------- render */

  const uploadInput = React.useRef<HTMLInputElement>(null);
  const readOnlyWhy = !perms.update ? 'Your role cannot write here (update on guestfiles)' : undefined;
  const noCreate = !perms.create ? 'Your role cannot create here (create on guestfiles)' : undefined;
  const noDelete = !perms.delete ? 'Your role cannot delete here (delete on guestfiles)' : undefined;
  const sessions = React.useSyncExternalStore(edits.subscribe, edits.getSnapshot).filter(s => s.vm.namespace === vm.namespace && s.vm.name === vm.name);

  const vmPane = (
    <Box component="section" aria-label="The VM’s files" {...dropProps('vm')} sx={paneSx(t, dropOn === 'vm')}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1.5, minHeight: 44, borderBottom: `1px solid ${t.rule}` }}>
        <PaneTitle icon="mdi:server">{vm.name}</PaneTitle>
        <Box sx={{ flex: 1 }} />
        {roots.length > 1 && (
          <Select size="small" value={rootOf(vmDir.path, roots, win) ?? ''} onChange={e => vmDir.go(String(e.target.value))} inputProps={{ 'aria-label': 'Filesystem' }} sx={{ fontSize: 13, height: 30 }} displayEmpty>
            {roots.map(r => (
              <MenuItem key={r} value={r}>
                {r}
              </MenuItem>
            ))}
          </Select>
        )}
      </Box>
      <PathBar win={win} path={vmDir.path} onGo={vmDir.go} />
      <Toolbar>
        <ToolButton icon="mdi:arrow-up" disabled={!parentPath(vmDir.path, win)} onClick={() => vmDir.go(parentPath(vmDir.path, win) ?? vmDir.path)}>
          Up
        </ToolButton>
        <ToolButton icon="mdi:refresh" onClick={vmDir.refresh}>
          Refresh
        </ToolButton>
        <ToolButton icon="mdi:folder-plus-outline" disabled={!!noCreate} tooltip={noCreate} onClick={newVmFolder}>
          New folder
        </ToolButton>
        <ToolButton icon="mdi:upload" disabled={!!readOnlyWhy} tooltip={readOnlyWhy} onClick={() => uploadInput.current?.click()}>
          Upload
        </ToolButton>
        <ToolButton
          icon={fsa && local.cur ? 'mdi:arrow-right-bold' : 'mdi:download'}
          disabled={!picked.length}
          tooltip={fsa && local.cur ? `Copy to ${local.path.join('/')} on this PC` : undefined}
          onClick={() => void download(picked)}
        >
          {fsa && local.cur ? 'Copy to this PC' : 'Download'}
        </ToolButton>
        {fsa && (
          <ToolButton icon="mdi:file-edit-outline" disabled={!one || one.type !== 'file' || !!readOnlyWhy} tooltip={readOnlyWhy} onClick={() => one && void editOnPc(one)}>
            Edit on this PC
          </ToolButton>
        )}
        <ToolButton
          icon="mdi:file-replace-outline"
          disabled={!one || one.type !== 'file' || !!readOnlyWhy}
          tooltip={readOnlyWhy}
          onClick={() => {
            replaceTarget.current = one ?? null;
            replaceInput.current?.click();
          }}
        >
          Replace with a local file
        </ToolButton>
        <ToolButton icon="mdi:rename-outline" disabled={!one || !!noCreate} tooltip={noCreate} onClick={() => one && void renameVm(one)}>
          Rename
        </ToolButton>
        <ToolButton icon="mdi:delete-outline" disabled={!picked.length || !!noDelete} tooltip={noDelete} onClick={() => void deleteVm(picked)}>
          Delete
        </ToolButton>
        <ToolButton icon="mdi:information-outline" disabled={!one} onClick={() => one && showProperties(ch, vmPath(one.name), one, osId)}>
          Properties
        </ToolButton>
        <Box sx={{ flex: 1 }} />
        <FilterField value={vmFilter} onChange={setVmFilter} label="Filter the VM’s files" />
      </Toolbar>
      <input
        ref={uploadInput}
        type="file"
        multiple
        hidden
        aria-label="Files to upload"
        onChange={e => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = '';
          void uploadFiles(files);
        }}
      />
      <input
        ref={replaceInput}
        type="file"
        hidden
        aria-label="The local file that replaces it"
        onChange={e => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void replaceWith(f);
        }}
      />
      {vmDir.loading && <LinearProgress sx={{ height: 2 }} aria-label="Listing" />}
      {vmDir.error ? (
        <Box sx={{ p: 2 }}>
          <Note icon="mdi:alert-circle-outline" tone="error">
            {errorText(vmDir.error, { path: vmDir.path, osId })}
          </Note>
        </Box>
      ) : (
        <FileList
          label={`Files in ${vmDir.path}`}
          entries={vmShown}
          selected={vmSel}
          onSelect={setVmSel}
          onOpen={e => vmDir.go(vmPath(e.name))}
          sort={vmSort}
          onSort={setVmSort}
          columns={{ mode: !win, owner: !win }}
          dragType={VM_DRAG}
          empty={vmDir.loading ? undefined : vmFilter ? 'Nothing matches the filter.' : 'This folder is empty, or the guest agent cannot see into it.'}
        />
      )}
      <Box sx={{ px: 1.5, py: 0.75, borderTop: `1px solid ${t.rule}`, fontSize: 12.5, color: t.muted, display: 'grid', gap: 0.5, ...tabular }}>
        {vmDir.listing && (
          <Box>
            {vmFilter ? `${vmShown.length} of ${vmEntries.length}` : vmEntries.length.toLocaleString()} {vmEntries.length === 1 ? 'entry' : 'entries'}
            {vmSel.size ? `, ${vmSel.size} selected` : ''}
          </Box>
        )}
        {vmDir.listing?.partial && <PartialNote shown={vmEntries.length} reason={vmDir.listing.partialReason} />}
      </Box>
    </Box>
  );

  const pcPane = fsa ? (
    <Box component="section" aria-label="This PC’s files" {...dropProps('pc')} sx={paneSx(t, dropOn === 'pc')}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1.5, minHeight: 44, borderBottom: `1px solid ${t.rule}` }}>
        <PaneTitle icon="mdi:laptop">This PC</PaneTitle>
        <Box sx={{ flex: 1 }} />
        <Button size="small" onClick={() => void local.pick()} sx={{ textTransform: 'none' }} startIcon={<Icon icon="mdi:folder-open-outline" width={16} />}>
          {local.cur ? 'Open another folder…' : 'Open a folder…'}
        </Button>
      </Box>
      {local.cur ? (
        <>
          <Box sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 0.25, px: 1, minHeight: 34, borderBottom: `1px solid ${t.rule}`, fontSize: 13 }} aria-label="Folder on this PC">
            {local.path.map((n, i) => (
              <React.Fragment key={i}>
                {i > 0 && <Icon icon="mdi:chevron-right" width={14} style={{ color: t.muted }} />}
                <Button size="small" color="inherit" onClick={() => local.to(i)} sx={{ textTransform: 'none', minWidth: 0, px: 0.75, py: 0, fontSize: 13 }}>
                  {n}
                </Button>
              </React.Fragment>
            ))}
          </Box>
          <Toolbar>
            <ToolButton icon="mdi:arrow-up" disabled={local.path.length < 2} onClick={() => local.to(local.path.length - 2)}>
              Up
            </ToolButton>
            <ToolButton icon="mdi:refresh" onClick={local.refresh}>
              Refresh
            </ToolButton>
            <ToolButton icon="mdi:folder-plus-outline" onClick={newPcFolder}>
              New folder
            </ToolButton>
            <ToolButton icon="mdi:arrow-left-bold" disabled={!pcSel.size || !!readOnlyWhy} tooltip={readOnlyWhy ?? `Copy to ${vmDir.path} in the VM`} onClick={() => void copySelectedToVm([...pcSel])}>
              Copy to the VM
            </ToolButton>
            <ToolButton icon="mdi:delete-outline" disabled={!pcSel.size} onClick={() => void deletePc(pcEntries.filter(e => pcSel.has(e.name)))}>
              Delete
            </ToolButton>
            <Box sx={{ flex: 1 }} />
            <FilterField value={pcFilter} onChange={setPcFilter} label="Filter this PC’s files" />
          </Toolbar>
          {local.error ? (
            <Box sx={{ p: 2 }}>
              <Note icon="mdi:alert-circle-outline" tone="error">
                {local.error}
              </Note>
            </Box>
          ) : (
            <FileList
              label={`Files in ${local.path.join('/')} on this PC`}
              entries={pcShown}
              selected={pcSel}
              onSelect={setPcSel}
              onOpen={e => void local.into(e.name)}
              sort={pcSort}
              onSort={setPcSort}
              columns={{ mode: false, owner: false }}
              dragType={PC_DRAG}
              empty={pcFilter ? 'Nothing matches the filter.' : 'This folder is empty.'}
            />
          )}
          <Box sx={{ px: 1.5, py: 0.75, borderTop: `1px solid ${t.rule}`, fontSize: 12.5, color: t.muted, ...tabular }}>
            {pcEntries.length.toLocaleString()} {pcEntries.length === 1 ? 'entry' : 'entries'}
            {pcSel.size ? `, ${pcSel.size} selected` : ''}
          </Box>
        </>
      ) : (
        <Box sx={{ p: 2, display: 'grid', gap: 1, fontSize: 13.5 }}>
          {local.saved ? (
            <>
              <Box>The browser asks again before Hangar may use {local.saved.name}.</Box>
              <Box>
                <Button variant="outlined" size="small" onClick={() => void local.reopen()} sx={{ textTransform: 'none' }}>
                  Reopen {local.saved.name}
                </Button>
              </Box>
            </>
          ) : (
            <Box sx={{ color: t.muted }}>
              Open a folder of this PC to copy files both ways, by the buttons or by dragging between the panes. Hangar keeps it for your next visit; the browser asks
              again for permission.
            </Box>
          )}
        </Box>
      )}
    </Box>
  ) : null;

  return (
    <Box sx={{ display: 'grid', gap: 1.5 }}>
      <Box sx={{ display: 'grid', gap: 0.5 }}>
        <ReachNote
          reach={reach}
          onShowChange={
            fa || reach === 'confined'
              ? () => {
                  setFaOpen(true);
                  window.setTimeout(() => document.getElementById('files-full-access')?.scrollIntoView({ behavior: 'smooth' }), 0);
                }
              : undefined
          }
        />
        {!fsa && (
          <Note icon="mdi:information-outline">
            This browser cannot open a folder of this PC (Chrome, Edge and Opera can): upload, download and “Replace with a local file” work here; the dual view and
            “Edit on this PC” need one of those.
          </Note>
        )}
        {bridgeNote}
        {notResponding && <AgentNotResponding message={agentMessage} restart={restartLine(osId)} />}
        {notice && (
          <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1 }}>
            <Box sx={{ flex: 1 }}>
              <Note icon={notice.tone === 'error' ? 'mdi:alert-circle-outline' : 'mdi:information-outline'} tone={notice.tone}>
                {notice.text}
              </Note>
            </Box>
            <Button size="small" color="inherit" onClick={() => setNotice(null)} sx={{ textTransform: 'none', minWidth: 0 }}>
              Dismiss
            </Button>
          </Box>
        )}
      </Box>
      {fix && (
        <Box id="files-blocked">
          <Panel title="Commands the guest blocks" icon="mdi:cancel">
            <BlockedFixBody fix={fix} commands={allBlocked} />
            {fa?.overridesAllowList && (
              <Box sx={{ mt: 1.25, fontSize: 13, color: t.muted }}>
                On this guest SELinux confines the agent as well: the change under “Let the guest agent reach every file” includes the drop-in, so it replaces both ways
                above.
              </Box>
            )}
          </Panel>
        </Box>
      )}
      <Box sx={{ display: 'grid', gap: 1.5, gridTemplateColumns: { xs: '1fr', lg: fsa ? 'minmax(0,1fr) minmax(0,1fr)' : '1fr' }, alignItems: 'stretch' }}>
        {vmPane}
        {pcPane}
      </Box>
      <TransferOptions
        win={win}
        verify={verify}
        onVerify={setVerify}
        ownerMode={ownerMode}
        onOwnerMode={setOwnerMode}
        ownerText={ownerText}
        onOwnerText={setOwnerText}
      />
      {fsa && <EditList sessions={sessions} />}
      {fa && <FullAccessPanel fa={fa} open={faOpen} onToggle={() => setFaOpen(o => !o)} />}
    </Box>
  );
}

const paneSx = (t: ReturnType<typeof useTokens>, drop: boolean) => ({
  border: `1px solid ${drop ? t.accent : t.rule}`,
  outline: drop ? `2px dashed ${t.accent}` : 'none',
  borderRadius: `${t.radius.panel}px`,
  background: t.surface,
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column' as const,
});

/* ------------------------------------------------------------ pieces */

function PathBar({ win, path, onGo }: { win: boolean; path: string; onGo: (p: string) => void }) {
  const t = useTokens();
  const [editing, setEditing] = React.useState(false);
  const [text, setText] = React.useState(path);
  const input = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => setText(path), [path]);
  React.useEffect(() => {
    if (editing) input.current?.focus();
  }, [editing]);
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.25, px: 1, minHeight: 34, borderBottom: `1px solid ${t.rule}`, fontSize: 13 }}>
      {editing ? (
        <TextField
          size="small"
          inputRef={input}
          fullWidth
          value={text}
          onChange={e => setText(e.target.value)}
          onBlur={() => setEditing(false)}
          onKeyDown={e => {
            if (e.key === 'Enter') {
              onGo(text);
              setEditing(false);
            }
            if (e.key === 'Escape') setEditing(false);
          }}
          inputProps={{ 'aria-label': 'Path in the VM', style: { fontFamily: t.font.mono, fontSize: 12.5, padding: '4px 8px' } }}
        />
      ) : (
        <>
          <Box component="nav" aria-label="Path in the VM" sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', flex: 1, minWidth: 0 }}>
            {crumbs(path, win).map((c, i) => (
              <React.Fragment key={c.path}>
                {i > 1 && <Icon icon="mdi:chevron-right" width={14} style={{ color: t.muted }} />}
                <Button size="small" color="inherit" onClick={() => onGo(c.path)} sx={{ textTransform: 'none', minWidth: 0, px: 0.75, py: 0, fontSize: 13, fontFamily: t.font.mono }}>
                  {c.label}
                </Button>
              </React.Fragment>
            ))}
          </Box>
          <Button size="small" color="inherit" onClick={() => setEditing(true)} aria-label="Type a path" sx={{ minWidth: 0, px: 0.5 }}>
            <Icon icon="mdi:pencil-outline" width={15} />
          </Button>
        </>
      )}
    </Box>
  );
}

function FilterField({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  return (
    <TextField
      size="small"
      placeholder="Filter"
      value={value}
      onChange={e => onChange(e.target.value)}
      inputProps={{ 'aria-label': label, style: { padding: '4px 8px', fontSize: 13 } }}
      sx={{ width: 140 }}
    />
  );
}

function TransferOptions(o: {
  win: boolean;
  verify: boolean;
  onVerify: (v: boolean) => void;
  ownerMode: OwnerMode;
  onOwnerMode: (m: OwnerMode) => void;
  ownerText: string;
  onOwnerText: (s: string) => void;
}) {
  const t = useTokens();
  const bad = o.ownerMode === 'custom' && !!o.ownerText.trim() && !!ownerProblem(o.ownerText);
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 2, fontSize: 13.5, color: t.muted }}>
      <FormControlLabel
        control={<Checkbox size="small" checked={o.verify} onChange={e => o.onVerify(e.target.checked)} />}
        label={`Check each copy’s SHA-256 against the guest’s (${o.win ? 'Get-FileHash' : 'sha256sum'})`}
        sx={{ m: 0, '& .MuiFormControlLabel-label': { fontSize: 13.5 } }}
      />
      {!o.win && (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <span id="files-owner-label">Owner of what Hangar creates in the VM:</span>
          <Select size="small" value={o.ownerMode} onChange={e => o.onOwnerMode(e.target.value as OwnerMode)} inputProps={{ 'aria-labelledby': 'files-owner-label' }} sx={{ fontSize: 13, height: 30 }}>
            <MenuItem value="folder">The folder’s owner</MenuItem>
            <MenuItem value="agent">The agent’s (root)</MenuItem>
            <MenuItem value="custom">Another…</MenuItem>
          </Select>
          {o.ownerMode === 'custom' && (
            <TextField
              size="small"
              placeholder="user:group"
              value={o.ownerText}
              onChange={e => o.onOwnerText(e.target.value)}
              error={!!bad}
              inputProps={{ 'aria-label': 'Owner, user:group', style: { padding: '4px 8px', fontSize: 13 } }}
              sx={{ width: 150 }}
            />
          )}
        </Box>
      )}
    </Box>
  );
}

const EDIT_STATE: Record<EditSession['state'], { text: string; icon: string; color?: string }> = {
  saving: { text: 'Saving to this PC…', icon: 'mdi:progress-download' },
  watching: { text: 'Same as in the VM', icon: 'mdi:check-circle-outline', color: '#2FBF71' },
  changed: { text: 'Changed on this PC', icon: 'mdi:pencil-circle-outline', color: '#3D8BFD' },
  writing: { text: 'Writing to the VM…', icon: 'mdi:progress-upload' },
  conflict: { text: 'Changed in the VM too', icon: 'mdi:alert-outline', color: '#E8A33D' },
  error: { text: 'Failed', icon: 'mdi:alert-circle-outline', color: '#E5484D' },
};

/** The files being edited on this PC, with their state and what to do. */
function EditList({ sessions }: { sessions: EditSession[] }) {
  const t = useTokens();
  const resolve = async (s: EditSession) => {
    const c = await askEditConflict(s.vmPath.split(/[\\/]/).pop() ?? s.vmPath, s.localName);
    if (c) await edits.writeBack(s.id, c);
  };
  return (
    <Panel title="Edited on this PC" icon="mdi:file-edit-outline">
      <Box sx={{ fontSize: 13, color: t.muted, mb: sessions.length ? 1.25 : 0 }}>
        “Edit on this PC” saves a VM file to this PC; open it there with any application. Hangar watches it and writes your saves back to the VM, checking first that
        the VM’s copy did not change meanwhile. Editing ends when you close or reload this page.
      </Box>
      {sessions.length > 0 && (
        <Box
          component="table"
          aria-label="Files edited on this PC"
          sx={{ width: '100%', borderCollapse: 'collapse', fontSize: 13.5, ...tabular, '& td, & th': { px: 1, py: 0.5, textAlign: 'left', borderTop: `1px solid ${t.rule}`, verticalAlign: 'top' }, '& th': { color: t.muted, fontWeight: 600, fontSize: 12.5, borderTop: 'none' } }}
        >
          <thead>
            <tr>
              <th>In the VM</th>
              <th>On this PC</th>
              <th>State</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {sessions.map(s => {
              const st = EDIT_STATE[s.state];
              return (
                <tr key={s.id}>
                  <Box component="td" sx={{ fontFamily: t.font.mono, fontSize: 12.5, overflowWrap: 'anywhere' }}>
                    {s.vmPath}
                  </Box>
                  <td>
                    {s.localName}
                    <Box sx={{ color: t.muted, fontSize: 12.5 }}>{s.folder ? `in ${s.folder}` : 'where you saved it'}</Box>
                  </td>
                  <td>
                    <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, color: st.color }}>
                      <Icon icon={st.icon} width={16} />
                      {st.text}
                    </Box>
                    {s.message && <Box sx={{ color: t.muted, fontSize: 12.5, maxWidth: 420 }}>{s.message}</Box>}
                    {s.writtenAt && s.state === 'watching' && <Box sx={{ color: t.muted, fontSize: 12.5 }}>Written at {new Date(s.writtenAt).toLocaleTimeString()}</Box>}
                  </td>
                  <Box component="td" sx={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
                    {(s.state === 'changed' || s.state === 'error') && (
                      <Button size="small" variant="contained" disableElevation onClick={() => void edits.writeBack(s.id)} sx={{ textTransform: 'none', mr: 1 }}>
                        Write to the VM
                      </Button>
                    )}
                    {s.state === 'conflict' && (
                      <Button size="small" variant="contained" color="warning" disableElevation onClick={() => void resolve(s)} sx={{ textTransform: 'none', mr: 1 }}>
                        Choose…
                      </Button>
                    )}
                    <FormControlLabel
                      control={<Checkbox size="small" checked={s.auto} onChange={e => edits.setAuto(s.id, e.target.checked)} />}
                      label="Write each save"
                      sx={{ m: 0, mr: 1, '& .MuiFormControlLabel-label': { fontSize: 13 } }}
                    />
                    <Button size="small" color="inherit" onClick={() => edits.stop(s.id)} sx={{ textTransform: 'none' }}>
                      Stop editing
                    </Button>
                  </Box>
                </tr>
              );
            })}
          </tbody>
        </Box>
      )}
    </Panel>
  );
}
