/* Opens the New VM wizard from anywhere (top bar, empty folders, library). */
import React from 'react';
import { openDialog } from '../ui/dialogs';
import { NewVmWizard, WizardPreset } from './NewVmWizard';

export function openNewVmWizard(preset: WizardPreset = {}) {
  openDialog(close => <NewVmWizard preset={preset} onClose={close} />);
}
