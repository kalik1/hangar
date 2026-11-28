import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { GUEST_AGENT_OPTION, GuestAgentOption } from './GuestAgentOption';

const box = () => screen.getByRole('checkbox', { name: GUEST_AGENT_OPTION }) as HTMLInputElement;

describe('the wizard option "Let the guest agent reach the whole guest" (hangar#15)', () => {
  it('is off by default and states the trade-off in two sentences', () => {
    const { container } = render(<GuestAgentOption custom={false} checked={false} onChange={() => undefined} />);
    expect(box().checked).toBe(false);
    expect(box().disabled).toBe(false);
    expect(container.textContent).toContain(
      'With this option, the agent, and so anyone with hangar-guest-admin on this VM, can read and change every file of the guest as root: that binding must be at least as strict as root SSH.'
    );
    expect(container.textContent).toContain('SELinux stays enforcing for everything else the agent does; on RHEL the option also overrides any FILTER_RPC_ARGS the guest\'s admin set.');
  });

  it('turns on', () => {
    const onChange = vi.fn();
    render(<GuestAgentOption custom={false} checked={false} onChange={onChange} />);
    fireEvent.click(box());
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('is greyed out with custom user data, unchecked, and says why', () => {
    const { container } = render(<GuestAgentOption custom checked onChange={() => undefined} />);
    expect(box().disabled).toBe(true);
    expect(box().checked).toBe(false);
    expect(container.textContent).toContain('Not with your own cloud-config: Hangar uses it as it is and adds nothing.');
  });
});
