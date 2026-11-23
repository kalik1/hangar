/*
 * Resource classes for the storage, library, network and snapshot views
 * that src/api/resources.ts does not have.
 */

import { KubeObject, KubeObjectInterface } from '@kinvolk/headlamp-plugin/lib/k8s/cluster';

type J = KubeObjectInterface & { spec?: any; status?: any };

export class VolumeSnapshot extends KubeObject<J> {
  static kind = 'VolumeSnapshot';
  static apiName = 'volumesnapshots';
  static apiVersion = 'snapshot.storage.k8s.io/v1';
  static isNamespaced = true;
}

/** API paths of the objects these views write. */
export const SPATHS = {
  vmSnapshots: (ns: string, name = '') =>
    `/apis/snapshot.kubevirt.io/v1beta1/namespaces/${ns}/virtualmachinesnapshots${name ? '/' + name : ''}`,
  vmRestores: (ns: string, name = '') =>
    `/apis/snapshot.kubevirt.io/v1beta1/namespaces/${ns}/virtualmachinerestores${name ? '/' + name : ''}`,
  nads: (ns: string, name = '') =>
    `/apis/k8s.cni.cncf.io/v1/namespaces/${ns}/network-attachment-definitions${name ? '/' + name : ''}`,
  uploadToken: (ns: string) => `/apis/upload.cdi.kubevirt.io/v1beta1/namespaces/${ns}/uploadtokenrequests`,
  roles: (ns: string, name = '') => `/apis/rbac.authorization.k8s.io/v1/namespaces/${ns}/roles${name ? '/' + name : ''}`,
  roleBindings: (ns: string, name = '') =>
    `/apis/rbac.authorization.k8s.io/v1/namespaces/${ns}/rolebindings${name ? '/' + name : ''}`,
  pods: () => '/api/v1/pods',
  podProxy: (ns: string, pod: string, port: number, path: string) => `/api/v1/namespaces/${ns}/pods/${pod}:${port}/proxy/${path}`,
};
