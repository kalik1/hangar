/*
 * Headlamp resource classes for the KubeVirt, CDI, Multus and snapshot
 * objects Hangar lists and watches. Views read their plain JSON
 * (`jsonData`); writes go through src/api/actions.ts.
 */

import { KubeObject, KubeObjectInterface } from '@kinvolk/headlamp-plugin/lib/k8s/cluster';

type J = KubeObjectInterface & { spec?: any; status?: any };

export class VirtualMachine extends KubeObject<J> {
  static kind = 'VirtualMachine';
  static apiName = 'virtualmachines';
  static apiVersion = 'kubevirt.io/v1';
  static isNamespaced = true;
}

export class VirtualMachineInstance extends KubeObject<J> {
  static kind = 'VirtualMachineInstance';
  static apiName = 'virtualmachineinstances';
  static apiVersion = 'kubevirt.io/v1';
  static isNamespaced = true;
}

export class VirtualMachineInstanceMigration extends KubeObject<J> {
  static kind = 'VirtualMachineInstanceMigration';
  static apiName = 'virtualmachineinstancemigrations';
  static apiVersion = 'kubevirt.io/v1';
  static isNamespaced = true;
}

export class KubeVirt extends KubeObject<J> {
  static kind = 'KubeVirt';
  static apiName = 'kubevirts';
  static apiVersion = 'kubevirt.io/v1';
  static isNamespaced = true;
}

export class VirtualMachineSnapshot extends KubeObject<J> {
  static kind = 'VirtualMachineSnapshot';
  static apiName = 'virtualmachinesnapshots';
  static apiVersion = ['snapshot.kubevirt.io/v1beta1', 'snapshot.kubevirt.io/v1alpha1'];
  static isNamespaced = true;
}

export class VirtualMachineRestore extends KubeObject<J> {
  static kind = 'VirtualMachineRestore';
  static apiName = 'virtualmachinerestores';
  static apiVersion = ['snapshot.kubevirt.io/v1beta1', 'snapshot.kubevirt.io/v1alpha1'];
  static isNamespaced = true;
}

export class VirtualMachineClone extends KubeObject<J> {
  static kind = 'VirtualMachineClone';
  static apiName = 'virtualmachineclones';
  static apiVersion = ['clone.kubevirt.io/v1beta1', 'clone.kubevirt.io/v1alpha1'];
  static isNamespaced = true;
}

export class VirtualMachineExport extends KubeObject<J> {
  static kind = 'VirtualMachineExport';
  static apiName = 'virtualmachineexports';
  static apiVersion = ['export.kubevirt.io/v1beta1', 'export.kubevirt.io/v1alpha1'];
  static isNamespaced = true;
}

export class VirtualMachinePool extends KubeObject<J> {
  static kind = 'VirtualMachinePool';
  static apiName = 'virtualmachinepools';
  static apiVersion = ['pool.kubevirt.io/v1beta1', 'pool.kubevirt.io/v1alpha1'];
  static isNamespaced = true;
}

export class ClusterInstancetype extends KubeObject<J> {
  static kind = 'VirtualMachineClusterInstancetype';
  static apiName = 'virtualmachineclusterinstancetypes';
  static apiVersion = ['instancetype.kubevirt.io/v1beta1', 'instancetype.kubevirt.io/v1alpha2'];
  static isNamespaced = false;
}

export class ClusterPreference extends KubeObject<J> {
  static kind = 'VirtualMachineClusterPreference';
  static apiName = 'virtualmachineclusterpreferences';
  static apiVersion = ['instancetype.kubevirt.io/v1beta1', 'instancetype.kubevirt.io/v1alpha2'];
  static isNamespaced = false;
}

export class MigrationPolicy extends KubeObject<J> {
  static kind = 'MigrationPolicy';
  static apiName = 'migrationpolicies';
  static apiVersion = 'migrations.kubevirt.io/v1alpha1';
  static isNamespaced = false;
}

export class DataVolume extends KubeObject<J> {
  static kind = 'DataVolume';
  static apiName = 'datavolumes';
  static apiVersion = 'cdi.kubevirt.io/v1beta1';
  static isNamespaced = true;
}

export class DataSource extends KubeObject<J> {
  static kind = 'DataSource';
  static apiName = 'datasources';
  static apiVersion = 'cdi.kubevirt.io/v1beta1';
  static isNamespaced = true;
}

export class DataImportCron extends KubeObject<J> {
  static kind = 'DataImportCron';
  static apiName = 'dataimportcrons';
  static apiVersion = 'cdi.kubevirt.io/v1beta1';
  static isNamespaced = true;
}

export class StorageProfile extends KubeObject<J> {
  static kind = 'StorageProfile';
  static apiName = 'storageprofiles';
  static apiVersion = 'cdi.kubevirt.io/v1beta1';
  static isNamespaced = false;
}

export class CDIConfig extends KubeObject<J> {
  static kind = 'CDIConfig';
  static apiName = 'cdiconfigs';
  static apiVersion = 'cdi.kubevirt.io/v1beta1';
  static isNamespaced = false;
}

export class NetworkAttachmentDefinition extends KubeObject<J> {
  static kind = 'NetworkAttachmentDefinition';
  static apiName = 'network-attachment-definitions';
  static apiVersion = 'k8s.cni.cncf.io/v1';
  static isNamespaced = true;
}

export class VolumeSnapshotClass extends KubeObject<J> {
  static kind = 'VolumeSnapshotClass';
  static apiName = 'volumesnapshotclasses';
  static apiVersion = 'snapshot.storage.k8s.io/v1';
  static isNamespaced = false;
}

export class NodeNetworkState extends KubeObject<J> {
  static kind = 'NodeNetworkState';
  static apiName = 'nodenetworkstates';
  static apiVersion = ['nmstate.io/v1beta1', 'nmstate.io/v1alpha1'];
  static isNamespaced = false;
}

export class CSIStorageCapacity extends KubeObject<J> {
  static kind = 'CSIStorageCapacity';
  static apiName = 'csistoragecapacities';
  static apiVersion = 'storage.k8s.io/v1';
  static isNamespaced = true;
}

/** API paths, for requests that do not go through the classes. */
export const PATHS = {
  vm: (ns: string, name = '') => `/apis/kubevirt.io/v1/namespaces/${ns}/virtualmachines${name ? '/' + name : ''}`,
  vmi: (ns: string, name = '') =>
    `/apis/kubevirt.io/v1/namespaces/${ns}/virtualmachineinstances${name ? '/' + name : ''}`,
  vmSub: (ns: string, name: string, sub: string) =>
    `/apis/subresources.kubevirt.io/v1/namespaces/${ns}/virtualmachines/${name}/${sub}`,
  vmiSub: (ns: string, name: string, sub: string) =>
    `/apis/subresources.kubevirt.io/v1/namespaces/${ns}/virtualmachineinstances/${name}/${sub}`,
  migrations: (ns: string, name = '') =>
    `/apis/kubevirt.io/v1/namespaces/${ns}/virtualmachineinstancemigrations${name ? '/' + name : ''}`,
  dv: (ns: string, name = '') => `/apis/cdi.kubevirt.io/v1beta1/namespaces/${ns}/datavolumes${name ? '/' + name : ''}`,
  pvc: (ns: string, name = '') => `/api/v1/namespaces/${ns}/persistentvolumeclaims${name ? '/' + name : ''}`,
  ns: (name = '') => `/api/v1/namespaces${name ? '/' + name : ''}`,
  node: (name: string) => `/api/v1/nodes/${name}`,
};
