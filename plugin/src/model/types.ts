/*
 * The slices of the KubeVirt, CDI and Kubernetes objects Hangar reads.
 * Loose on purpose: fields are optional and unknown ones pass through, so
 * newer KubeVirt versions do not break the views.
 */

export interface Meta {
  name: string;
  namespace?: string;
  uid?: string;
  resourceVersion?: string;
  creationTimestamp?: string;
  deletionTimestamp?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  ownerReferences?: { kind: string; name: string; uid?: string; apiVersion?: string; controller?: boolean }[];
  generation?: number;
  /** Who wrote which field (src/model/ownership.ts). */
  managedFields?: ManagedFieldsEntry[];
}

/** One writer's fields, as the API server records them (FieldsV1 tree). */
export interface ManagedFieldsEntry {
  manager?: string;
  operation?: string;
  apiVersion?: string;
  fieldsType?: string;
  fieldsV1?: Record<string, unknown>;
  subresource?: string;
  time?: string;
}

export interface Obj {
  apiVersion?: string;
  kind?: string;
  metadata: Meta;
  spec?: any;
  status?: any;
  [k: string]: any;
}

export interface Condition {
  type: string;
  status: string;
  reason?: string;
  message?: string;
  lastTransitionTime?: string;
  lastProbeTime?: string | null;
}

export interface VMDisk {
  name: string;
  disk?: { bus?: string; readonly?: boolean };
  cdrom?: { bus?: string; readonly?: boolean; tray?: string };
  lun?: { bus?: string };
  bootOrder?: number;
  serial?: string;
  cache?: string;
  shareable?: boolean;
}

export interface VMVolume {
  name: string;
  dataVolume?: { name: string; hotpluggable?: boolean };
  persistentVolumeClaim?: { claimName: string; readOnly?: boolean; hotpluggable?: boolean };
  containerDisk?: { image: string };
  cloudInitNoCloud?: { userData?: string; userDataBase64?: string; networkData?: string; secretRef?: { name: string } };
  cloudInitConfigDrive?: { userData?: string; secretRef?: { name: string } };
  configMap?: { name: string };
  secret?: { secretName: string };
  serviceAccount?: { serviceAccountName: string };
  emptyDisk?: { capacity: string };
  ephemeral?: { persistentVolumeClaim: { claimName: string } };
  hostDisk?: { path: string; type: string; capacity?: string };
  sysprep?: unknown;
  downwardMetrics?: unknown;
}

export interface VMInterface {
  name: string;
  model?: string;
  macAddress?: string;
  masquerade?: object;
  bridge?: object;
  sriov?: object;
  binding?: { name: string };
  bootOrder?: number;
  state?: string;
  ports?: { name?: string; port: number; protocol?: string }[];
}

export interface VMNetwork {
  name: string;
  pod?: { vmNetworkCIDR?: string };
  multus?: { networkName: string; default?: boolean };
}

export type VM = Obj;
export type VMI = Obj;
