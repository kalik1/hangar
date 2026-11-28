/*
 * Parts the Summary and the Guest tab share: where a section's data comes
 * from and when it was read, why the guest bridge has nothing (not
 * installed, no permission, not answering), the agent's state (not
 * connected, with how to install it; not responding, with how to restart
 * it), a command's failure, and the guest-side lines that enable blocked
 * commands.
 */

import { Icon } from '@iconify/react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import React from 'react';
import { writeHostClipboard } from '../../console/ClipboardTray';
import { AGENT_WHY, BlockedFix, BridgeState, GuestInfoError, InstallHint } from '../../model/guestinfo';
import { tabular } from '../../ui/tokens';
import { useTokens } from '../../ui/useTokens';

export const timeOf = (ms: number | string | undefined) => (ms === undefined ? '—' : new Date(ms).toLocaleTimeString());

/** Lines to run in the guest, with a copy button. */
export function CommandBlock({ lines, label }: { lines: string[]; label?: string }) {
  const t = useTokens();
  const [copied, setCopied] = React.useState(false);
  const text = lines.join('\n');
  return (
    <Box sx={{ position: 'relative', mt: 0.75 }}>
      <Box
        component="pre"
        aria-label={label}
        sx={{
          m: 0,
          p: 1.25,
          pr: 9,
          fontFamily: t.font.mono,
          fontSize: 12.5,
          background: t.hover,
          border: `1px solid ${t.rule}`,
          borderRadius: `${t.radius.small}px`,
          overflowX: 'auto',
          whiteSpace: 'pre',
        }}
      >
        {text}
      </Box>
      <Button
        size="small"
        onClick={() => writeHostClipboard(text).then(ok => ok && (setCopied(true), window.setTimeout(() => setCopied(false), 1500)))}
        sx={{ position: 'absolute', top: 4, right: 4, textTransform: 'none', minWidth: 0 }}
        startIcon={<Icon icon={copied ? 'mdi:check' : 'mdi:content-copy'} width={14} />}
      >
        {copied ? 'Copied' : 'Copy'}
      </Button>
    </Box>
  );
}

/** A muted line with an icon: a notice inside a section. */
export function Note({ icon, tone, children }: { icon: string; tone?: 'warn' | 'error'; children: React.ReactNode }) {
  const t = useTokens();
  const color = tone === 'error' ? '#C53030' : tone === 'warn' ? '#B7791F' : t.muted;
  return (
    <Box role={tone ? 'status' : undefined} sx={{ display: 'flex', gap: 0.75, alignItems: 'baseline', fontSize: 13, color: tone ? t.text : t.muted, lineHeight: 1.5 }}>
      <Icon icon={icon} width={15} style={{ flex: 'none', position: 'relative', top: 3, color }} />
      <Box sx={{ minWidth: 0, overflowWrap: 'anywhere' }}>{children}</Box>
    </Box>
  );
}

export type Source = 'bridge' | 'kubevirt' | 'status' | 'spec';

const SOURCE_NAMES: Record<Source, string> = {
  bridge: 'the guest bridge',
  kubevirt: 'KubeVirt’s API',
  status: 'the VMI’s status',
  spec: 'the VM’s settings',
};

/** Where a section's data comes from, and when it was read. */
export function SourceLine({ source, commands, readAt }: { source: Source; commands?: string[]; readAt?: number | string }) {
  const t = useTokens();
  return (
    <Box sx={{ fontSize: 12.5, color: t.muted, ...tabular }}>
      From {SOURCE_NAMES[source]}
      {commands?.length ? <> ({commands.join(', ')})</> : null}
      {readAt !== undefined && <>, read at {timeOf(readAt)}</>}.
    </Box>
  );
}

/** Why a section that needs the bridge shows nothing from it, and what it would add. */
export function BridgeNotice({ state, adds }: { state: BridgeState; adds?: string }) {
  switch (state.kind) {
    case 'absent':
      return (
        <Note icon="mdi:puzzle-outline">
          Needs Hangar’s guest bridge, which this cluster does not have{adds ? `. It adds ${adds}.` : '.'}
        </Note>
      );
    case 'forbidden':
      return (
        <Note icon="mdi:lock-outline" tone="warn">
          Your role cannot read the guest agent’s report on this VM: it needs get on virtualmachineinstances/guestinfo
          (subresources.hangar.magesgate.com), which the role {state.role} grants.
        </Note>
      );
    case 'unavailable':
      return (
        <Note icon="mdi:lan-disconnect" tone="warn">
          {state.apiService ? 'The guest bridge does not answer.' : 'The guest bridge cannot reach this VM yet; Hangar asks again.'} {state.message}
        </Note>
      );
    case 'error':
      return (
        <Note icon="mdi:alert-circle-outline" tone="error">
          The guest bridge failed: {state.message}
        </Note>
      );
    case 'loading':
      return <Note icon="mdi:timer-sand">Asking the guest bridge…</Note>;
    default:
      return null;
  }
}

/** The guest agent is not connected: how to install it for this OS, and why. */
export function InstallAgent({ hint }: { hint: InstallHint }) {
  const t = useTokens();
  return (
    <Box sx={{ fontSize: 13.5 }}>
      <Box>{hint.text}</Box>
      {hint.lines && <CommandBlock lines={hint.lines} label="Install the guest agent" />}
      <Box sx={{ color: t.muted, fontSize: 12.5, mt: 0.75 }}>{AGENT_WHY}</Box>
    </Box>
  );
}

/** The agent does not respond (the bridge's health): what the bridge says, and the restart line. */
export function AgentNotResponding({ message, restart }: { message?: string; restart: string }) {
  return (
    <Box sx={{ display: 'grid', gap: 0.5 }}>
      <Note icon="mdi:heart-broken-outline" tone="error">
        <b>The guest agent does not respond.</b> {message ?? ''} KubeVirt may still say it is connected; Hangar asks it once every 30 s.
        Restarting the agent in the guest brings it back:
      </Note>
      <CommandBlock lines={[restart]} label="Restart the guest agent" />
    </Box>
  );
}

/** A section's commands that gave no answer. */
export function SectionErrors({ errors, fixId }: { errors: GuestInfoError[]; fixId?: string }) {
  if (!errors.length) return null;
  return (
    <Box sx={{ display: 'grid', gap: 0.5, mt: 1.25 }}>
      {errors.map((e, i) => {
        const cmd = e.command ?? e.section;
        switch (e.reason) {
          case 'Blocked':
            return (
              <Note key={i} icon="mdi:cancel" tone="warn">
                <code>{cmd}</code> is blocked by the guest’s agent configuration.{' '}
                {fixId && (
                  <a href={`#${fixId}`} onClick={ev => (ev.preventDefault(), document.getElementById(fixId)?.scrollIntoView({ behavior: 'smooth' }))}>
                    How to enable it
                  </a>
                )}
              </Note>
            );
          case 'NotSupported':
            return (
              <Note key={i} icon="mdi:information-outline">
                {capital(e.message)}.
              </Note>
            );
          case 'Timeout':
            return (
              <Note key={i} icon="mdi:timer-alert-outline" tone="warn">
                <code>{cmd}</code> did not answer in time: {e.message}
              </Note>
            );
          default:
            return (
              <Note key={i} icon="mdi:alert-circle-outline" tone="error">
                <code>{cmd}</code> failed in the guest: {e.message}
              </Note>
            );
        }
      })}
    </Box>
  );
}

const capital = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s).replace(/\.$/, '');

/** The guest-side change that enables the blocked commands. */
export function BlockedFixBody({ fix, commands }: { fix: BlockedFix; commands: string[] }) {
  const t = useTokens();
  return (
    <Box sx={{ display: 'grid', gap: 1.5, fontSize: 13.5 }}>
      <Box>
        The guest’s agent configuration blocks{' '}
        {commands.map((c, i) => (
          <React.Fragment key={c}>
            {i > 0 && ', '}
            <code>{c}</code>
          </React.Fragment>
        ))}
        . Hangar never calls a blocked command. {fix.where}
      </Box>
      {fix.ways.map(w => (
        <Box key={w.title}>
          <Box sx={{ fontWeight: 600 }}>{w.title}</Box>
          {w.note && <Box sx={{ color: t.muted, fontSize: 12.5, mt: 0.25 }}>{w.note}</Box>}
          <CommandBlock lines={w.lines} label={w.title} />
          {w.revert && (
            <Box sx={{ mt: 0.75 }}>
              <Box sx={{ color: t.muted, fontSize: 12.5 }}>To undo it:</Box>
              <CommandBlock lines={w.revert} label={`Undo: ${w.title}`} />
            </Box>
          )}
        </Box>
      ))}
    </Box>
  );
}
