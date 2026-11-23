import { useTheme } from '@mui/material/styles';
import { HangarTokens, hangarTokens } from './tokens';

/** Hangar tokens for the current Headlamp theme (light or dark). */
export function useTokens(): HangarTokens {
  return hangarTokens(useTheme());
}
