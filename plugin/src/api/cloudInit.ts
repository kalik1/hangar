/*
 * cloud-init user data over KubeVirt's inline limit (2,048 bytes, the VMI
 * admitter's cloudInitUserMaxLen): Hangar keeps it in a Secret of the VM's
 * folder (cloudInitNoCloud.secretRef) instead of letting KubeVirt refuse the
 * VM, and refuses with the reason when it cannot make the Secret. The
 * Secret is owned by the VM, so it goes when the VM goes; a copy of the VM
 * gets the text (readCloudInitSecrets) in a Secret of its own.
 */

import { Obj, VM } from '../model/types';
import { cloudInitOverflow, cloudInitRefusal, cloudInitSecret, copiedCloudInit, withCloudInitSecret } from '../model/vmspec';
import { errorText, kdelete, kmerge, kpost, kreq } from './client';

const secretPath = (ns: string, name = '') => `/api/v1/namespaces/${ns}/secrets${name ? '/' + name : ''}`;

/**
 * Creates `vm` with `create`. Inline user data KubeVirt would refuse, and
 * the user data `copied` from a source VM's Secrets (volume → text), go
 * into Secrets first; when one cannot be made, nothing is created and the
 * error says why. Once the VM exists it owns them; a failed create deletes
 * them.
 */
export async function createWithCloudInit(vm: VM, create: (vm: VM) => Promise<Obj>, copied?: Map<string, string>): Promise<Obj> {
  const ns = vm.metadata.namespace as string;
  const made: string[] = [];
  const drop = () => Promise.all(made.map(n => kdelete(secretPath(ns, n)).catch(() => undefined)));
  let out = vm;
  for (const o of [...cloudInitOverflow(vm), ...copiedCloudInit(vm, copied ?? new Map())]) {
    try {
      const secret = await kpost<Obj>(secretPath(ns), cloudInitSecret(vm, o));
      made.push(secret.metadata.name);
      out = withCloudInitSecret(out, o.volume, secret.metadata.name);
    } catch (e) {
      await drop();
      throw new Error(cloudInitRefusal(o, errorText(e)));
    }
  }
  let created: Obj;
  try {
    created = await create(out);
  } catch (e) {
    await drop();
    throw e;
  }
  const uid = created?.metadata?.uid;
  if (uid)
    await Promise.all(
      made.map(n =>
        // Without patch on Secrets it stays after the VM is deleted: nothing else depends on that.
        kmerge(secretPath(ns, n), {
          metadata: { ownerReferences: [{ apiVersion: 'kubevirt.io/v1', kind: 'VirtualMachine', name: vm.metadata.name, uid }] },
        }).catch(() => undefined)
      )
    );
  return created;
}

const fromBase64 = (b64: string) => new TextDecoder().decode(Uint8Array.from(atob(b64), c => c.charCodeAt(0)));

/**
 * The user data of the VM's cloud-init volumes kept in Secrets (volume
 * name → text), for a copy of the VM (createWithCloudInit's `copied`). A
 * Secret Hangar may not read, or without user data, is left out: the copy
 * then keeps the reference, as before.
 */
export async function readCloudInitSecrets(vm: VM): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ns = vm.metadata.namespace as string;
  await Promise.all(
    (vm.spec?.template?.spec?.volumes ?? []).map(async (v: any) => {
      const name = (v.cloudInitNoCloud ?? v.cloudInitConfigDrive)?.secretRef?.name;
      if (!name) return;
      try {
        const s = await kreq<Obj>(secretPath(ns, name));
        const b64 = s?.data?.userdata ?? s?.data?.userData;
        if (typeof b64 === 'string') out.set(v.name, fromBase64(b64));
      } catch {
        // not readable: keep the reference
      }
    })
  );
  return out;
}
