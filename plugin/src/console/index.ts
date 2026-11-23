/*
 * Hangar's console module: the graphical console (noVNC), the serial
 * console (xterm.js), live screen thumbnails and console windows.
 */

export { VncConsole } from './VncConsole';
export type { VncConsoleProps } from './VncConsole';
export { SerialConsole } from './SerialConsole';
export type { SerialConsoleProps } from './SerialConsole';
export { ConsoleThumbnail, fetchScreenshot } from './ConsoleThumbnail';
export type { ConsoleThumbnailProps } from './ConsoleThumbnail';
export { closeConsoleWindow, openConsoleWindow } from './openConsoleWindow';
export type { OpenConsoleWindowOptions } from './openConsoleWindow';
export type { ConsoleKind } from './paths';
export { ConsolePopupPage } from './ConsolePopupPage';
export { consolePopupFeatures, consolePopupKey, consolePopupName, openOrFocusPopup, POPUP_ROUTE_NAME, POPUP_ROUTE_PATH } from './popup';
export { closePopup, notePopupOpening, useConsolePopupOpen } from './popupPresence';
export { resolveCluster } from './useConsoleSession';
