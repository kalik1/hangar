import { describe, expect, it } from 'vitest';
import {
  alignedClipboardSidecars,
  CLIPBOARD_HOOK_CM,
  CLIPBOARD_HOOK_SCRIPT,
  clipboardMode,
  clipboardOnVm,
  HOOK_ANNOTATION,
  parseSidecars,
  setClipboardAnnotation,
  shouldSendToVm,
  sidecarGateOn,
  sidecarImage,
  withClipboard,
  withSidecarGate,
} from './clipboard';

const IMG = 'quay.io/kubevirt/sidecar-shim:v1.7.0';
const vmWith = (ann?: Record<string, string>) => ({ metadata: { name: 'd', namespace: 'demo' }, spec: { template: { metadata: { annotations: ann }, spec: {} } } }) as any;
const other = { args: ['--version', 'v1alpha2'], image: 'example/smbios:1', configMap: { name: 'smbios-hook', key: 'x.sh', hookPath: '/usr/bin/onDefineDomain' } };

describe('annotation', () => {
  it('parses lists, rejects garbage', () => {
    expect(parseSidecars(undefined)).toEqual([]);
    expect(parseSidecars('[]')).toEqual([]);
    expect(parseSidecars('{"a":1}')).toBeNull();
    expect(parseSidecars('nope')).toBeNull();
  });
  it('adds and removes Hangar hook, keeping other sidecars', () => {
    const on = setClipboardAnnotation({ [HOOK_ANNOTATION]: JSON.stringify([other]), keep: 'me' }, true, IMG);
    const list = JSON.parse(on[HOOK_ANNOTATION]);
    expect(list).toHaveLength(2);
    expect(list[1]).toEqual({ args: ['--version', 'v1alpha2'], image: IMG, configMap: { name: CLIPBOARD_HOOK_CM, key: 'onDefineDomain.sh', hookPath: '/usr/bin/onDefineDomain' } });
    expect(on.keep).toBe('me');
    const again = setClipboardAnnotation(on, true, IMG);
    expect(JSON.parse(again[HOOK_ANNOTATION])).toHaveLength(2);
    const off = setClipboardAnnotation(on, false, IMG);
    expect(JSON.parse(off[HOOK_ANNOTATION])).toEqual([other]);
    expect(setClipboardAnnotation(setClipboardAnnotation({}, true, IMG), false, IMG)).toEqual({});
  });
  it('refuses to overwrite an annotation it cannot read', () => {
    expect(() => setClipboardAnnotation({ [HOOK_ANNOTATION]: 'not json' }, true, IMG)).toThrow(/cannot read/);
  });
  it('edits a copy of the VM', () => {
    const vm = vmWith(undefined);
    const next = withClipboard(vm, true, IMG);
    expect(clipboardOnVm(next)).toBe(true);
    expect(clipboardOnVm(vm)).toBe(false);
    expect(withClipboard(next, false, IMG).spec.template.metadata.annotations).toBeUndefined();
  });
});

describe('sidecar image at the next power-on', () => {
  const NEW = 'quay.io/kubevirt/sidecar-shim:v1.9.1';
  it('moves Hangar hook to the cluster image, other sidecars as they are', () => {
    const ann = setClipboardAnnotation({ [HOOK_ANNOTATION]: JSON.stringify([other]) }, true, IMG);
    const value = alignedClipboardSidecars(ann, NEW);
    expect(JSON.parse(value!)).toEqual([other, { ...JSON.parse(ann[HOOK_ANNOTATION])[1], image: NEW }]);
  });
  it('leaves an up-to-date, missing or unreadable hook alone', () => {
    expect(alignedClipboardSidecars(setClipboardAnnotation({}, true, NEW), NEW)).toBeNull();
    expect(alignedClipboardSidecars({ [HOOK_ANNOTATION]: JSON.stringify([other]) }, NEW)).toBeNull();
    expect(alignedClipboardSidecars(undefined, NEW)).toBeNull();
    expect(alignedClipboardSidecars({ [HOOK_ANNOTATION]: 'not json' }, NEW)).toBeNull();
  });
});

describe('mode', () => {
  const on = withClipboard(vmWith(undefined), true, IMG);
  const vmiOn = { metadata: { annotations: on.spec.template.metadata.annotations }, status: { phase: 'Running' } } as any;
  const vmiOff = { metadata: { annotations: {} }, status: { phase: 'Running' } } as any;
  it('tells the console what works now', () => {
    expect(clipboardMode(on, vmiOn)).toBe('shared');
    expect(clipboardMode(on, vmiOff)).toBe('pending');
    expect(clipboardMode(vmWith(undefined), vmiOn)).toBe('off-pending');
    expect(clipboardMode(vmWith(undefined), vmiOff)).toBe('none');
    expect(clipboardMode(on, null)).toBe('shared');
  });
});

describe('cluster', () => {
  it('builds the sidecar image from the KubeVirt status', () => {
    expect(sidecarImage({ status: { observedKubeVirtRegistry: 'registry.example/kv/', observedKubeVirtVersion: 'v1.7.2' } } as any)).toBe('registry.example/kv/sidecar-shim:v1.7.2');
    expect(sidecarImage(null)).toBe(IMG);
  });
  it('adds the Sidecar gate and keeps the others', () => {
    const kv = { metadata: { name: 'kubevirt' }, spec: { configuration: { developerConfiguration: { featureGates: ['HostDevices', 'Snapshot'] } } } } as any;
    expect(sidecarGateOn(kv)).toBe(false);
    const out = withSidecarGate(kv);
    expect(out.spec.configuration.developerConfiguration.featureGates).toEqual(['HostDevices', 'Snapshot', 'Sidecar']);
    expect(withSidecarGate(out).spec.configuration.developerConfiguration.featureGates).toEqual(['HostDevices', 'Snapshot', 'Sidecar']);
    expect(withSidecarGate({ metadata: {} } as any).spec.configuration.developerConfiguration.featureGates).toEqual(['Sidecar']);
    expect(kv.spec.configuration.developerConfiguration.featureGates).toHaveLength(2);
  });
});

describe('paste', () => {
  it('sends only a changed clipboard', () => {
    expect(shouldSendToVm('abc', null)).toBe(true);
    expect(shouldSendToVm('abc', 'abc')).toBe(false);
    expect(shouldSendToVm('abd', 'abc')).toBe(true);
    expect(shouldSendToVm('', null)).toBe(false);
  });
});

describe('hook script', () => {
  it('is a shell script that adds the vdagent port as QEMU arguments', () => {
    expect(CLIPBOARD_HOOK_SCRIPT.startsWith('#!/bin/sh\n')).toBe(true);
    expect(CLIPBOARD_HOOK_SCRIPT).toContain('qemu-vdagent,id=hangarvdagent,name=vdagent,clipboard=on,mouse=off');
    expect(CLIPBOARD_HOOK_SCRIPT).toContain('"name":"com.redhat.spice.0"');
    expect(CLIPBOARD_HOOK_SCRIPT).toContain('xmlns:qemu="http://libvirt.org/schemas/domain/qemu/1.0"');
  });
});
