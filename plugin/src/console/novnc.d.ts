/* The part of noVNC's RFB class (core/rfb.js, 1.4) the console uses; the package ships no types. */
declare module '@novnc/novnc/core/rfb.js' {
  export interface RFBOptions {
    shared?: boolean;
    credentials?: { username?: string; password?: string; target?: string };
    repeaterID?: string;
    wsProtocols?: string[];
  }

  export default class RFB extends EventTarget {
    /** `urlOrChannel`: a WebSocket URL, or an object that behaves like a WebSocket. */
    constructor(target: HTMLElement, urlOrChannel: string | object, options?: RFBOptions);
    viewOnly: boolean;
    focusOnClick: boolean;
    clipViewport: boolean;
    dragViewport: boolean;
    scaleViewport: boolean;
    resizeSession: boolean;
    showDotCursor: boolean;
    background: string;
    qualityLevel: number;
    compressionLevel: number;
    readonly capabilities: { power?: boolean };
    disconnect(): void;
    sendCtrlAltDel(): void;
    sendKey(keysym: number, code: string | null, down?: boolean): void;
    focus(options?: FocusOptions): void;
    blur(): void;
    toBlob(callback: (blob: Blob | null) => void, type?: string, quality?: number): void;
    toDataURL(type?: string, encoderOptions?: number): string;
    /** Puts text on the server's clipboard (extended clipboard when the server supports it). */
    clipboardPasteFrom(text: string): void;
  }
}
