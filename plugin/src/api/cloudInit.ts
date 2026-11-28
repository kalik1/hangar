/*
 * cloud-init user data over KubeVirt's inline limit (2,048 bytes, the VMI
 * admitter's cloudInitUserMaxLen): Hangar keeps it in a Secret of the VM's
 * folder (cloudInitNoCloud.secretRef) instead of letting KubeVirt refuse the
 * VM, and refuses with the reason when it cannot make the Secret.
 *
 * Making it needs only `create` on Secrets (hangar-vm-admin has it): the VM
 * is created first, which gives its UID, then the Secret, owned by the VM
 * from its creation, so the garbage collector deletes it with the VM and
 * nothing is patched. A server-side dry run of the Secret comes before the
 * VM, so a refusal (rights, quota, admission) creates nothing; if the real
 * Secret still fails, the VM just created is deleted again. A VM created
 * running waits for the Secret for that moment: the kubelet retries the
 * mount.
 *
 * A copy of a VM whose user data is in a Secret gets a Secret of its own,
 * in the same order. Reading the source's Secret needs `get`, which no
 * Hangar role gives: it works for users with their own rights on Secrets,
 * and the copy dialog says what the copy gets without them.
 */

import { Obj, VM } from '../model/types';
import { cloudInitOverflow, cloudInitRefusal, cloudInitSecret, cloudInitSecretName, cloudInitSecretRefs, copiedCloudInit, withCloudInitSecret } from '../model/vmspec';
import { errorText, kdelete, kpost, kreq } from './client';

const secretPath = (ns: string, name = '') => `/api/v1/namespaces/${ns}/secrets${name ? '/' + name : ''}`;
const vmPath = (ns: string, name: string) => `/apis/kubevirt.io/v1/namespaces/${ns}/virtualmachines/${name}`;

/**
 * Creates `vm` with `create`. Inline user data KubeVirt would refuse, and
 * the user data `copied` from a source VM's Secrets (volume → text), go
 * into Secrets of the VM's own. When one cannot be made the error says why,
 * and no VM is left behind.
 */
export async function createWithCloudInit(vm: VM, create: (vm: VM) => Promise<Obj>, copied?: Map<string, string>): Promise<Obj> {
  const ns = vm.metadata.namespace as string;
  const plan = [...cloudInitOverflow(vm), ...copiedCloudInit(vm, copied ?? new Map())].map(o => ({ o, name: cloudInitSecretName(vm.metadata.name) }));
  if (!plan.length) return create(vm);
  let out = vm;
  for (const p of plan) {
    // Asked first: refused, nothing is created.
    try {
      await kpost(secretPath(ns), cloudInitSecret(vm, p.o, p.name), { dryRun: 'All' });
    } catch (e) {
      throw new Error(cloudInitRefusal(p.o, errorText(e)));
    }
    out = withCloudInitSecret(out, p.o.volume, p.name);
  }
  const created = await create(out);
  const uid = created?.metadata?.uid;
  for (const p of plan) {
    try {
      await kpost(secretPath(ns), cloudInitSecret(vm, p.o, p.name, uid));
    } catch (e) {
      // The Secrets made so far are the VM's: they go with it.
      const gone = await kdelete(vmPath(ns, vm.metadata.name), { kind: 'DeleteOptions', apiVersion: 'v1', propagationPolicy: 'Background' }).then(
        () => true,
        () => false
      );
      throw new Error(
        cloudInitRefusal(p.o, errorText(e)) + (gone ? '' : ` The VM ${vm.metadata.name} was created and Hangar could not delete it again: delete it.`)
      );
    }
  }
  return created;
}

const fromBase64 = (b64: string) => new TextDecoder().decode(Uint8Array.from(atob(b64), c => c.charCodeAt(0)));

export interface CopiedCloudInit {
  /** Volume → user data, for createWithCloudInit's `copied`. */
  texts: Map<string, string>;
  /** Volumes whose Secret Hangar could not read. */
  unreadable: string[];
}

/**
 * The user data of the VM's cloud-init volumes kept in Secrets, for a copy
 * of the VM. Needs `get` on the source's Secrets, which no Hangar role
 * gives: a Secret Hangar may not read, or without user data, is listed in
 * `unreadable`.
 */
export async function readCloudInitSecrets(vm: VM): Promise<CopiedCloudInit> {
  const out: CopiedCloudInit = { texts: new Map(), unreadable: [] };
  const ns = vm.metadata.namespace as string;
  await Promise.all(
    cloudInitSecretRefs(vm).map(async r => {
      try {
        const s = await kreq<Obj>(secretPath(ns, r.secret));
        const b64 = s?.data?.userdata ?? s?.data?.userData;
        if (typeof b64 === 'string') out.texts.set(r.volume, fromBase64(b64));
        else out.unreadable.push(r.volume);
      } catch {
        out.unreadable.push(r.volume);
      }
    })
  );
  return out;
}
