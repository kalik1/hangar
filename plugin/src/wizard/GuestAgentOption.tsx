/*
 * The New VM wizard's "Let the guest agent reach the whole guest"
 * (hangar#15, model/vmspec.ts GUEST_AGENT_FULL_ACCESS): off by default,
 * with the trade-off in two sentences. Greyed out with the user's own
 * cloud-config, which Hangar passes on unchanged.
 */

import Checkbox from '@mui/material/Checkbox';
import FormControlLabel from '@mui/material/FormControlLabel';
import Typography from '@mui/material/Typography';
import React from 'react';
import { useTokens } from '../ui/useTokens';

export const GUEST_AGENT_OPTION = 'Let the guest agent reach the whole guest';

export function GuestAgentOption({ custom, checked, onChange }: { custom: boolean; checked: boolean; onChange: (on: boolean) => void }) {
  const t = useTokens();
  return (
    <>
      <FormControlLabel disabled={custom} control={<Checkbox checked={!custom && checked} onChange={e => onChange(e.target.checked)} />} label={GUEST_AGENT_OPTION} />
      <Typography sx={{ fontSize: 12.5, color: t.muted, lineHeight: 1.5 }}>
        {custom ? (
          'Not with your own cloud-config: Hangar uses it as it is and adds nothing.'
        ) : (
          <>
            With this option, the agent, and so anyone with <code>hangar-guest-admin</code> on this VM, can read and change every file of the guest as root: that binding must be
            at least as strict as root SSH. SELinux stays enforcing for everything else the agent does; on RHEL the option also overrides any <code>FILTER_RPC_ARGS</code> the
            guest&apos;s admin set.
          </>
        )}
      </Typography>
    </>
  );
}
