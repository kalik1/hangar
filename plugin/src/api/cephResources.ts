/*
 * Rook-Ceph objects Hangar reads to show Ceph pools as datastores: the
 * cluster (health, raw capacity) and its block pools (replicas, state).
 * Read only: Ceph is managed with Rook, not from Hangar.
 */

import { KubeObject, KubeObjectInterface } from '@kinvolk/headlamp-plugin/lib/k8s/cluster';

type J = KubeObjectInterface & { spec?: any; status?: any };

export class CephCluster extends KubeObject<J> {
  static kind = 'CephCluster';
  static apiName = 'cephclusters';
  static apiVersion = 'ceph.rook.io/v1';
  static isNamespaced = true;
}

export class CephBlockPool extends KubeObject<J> {
  static kind = 'CephBlockPool';
  static apiName = 'cephblockpools';
  static apiVersion = 'ceph.rook.io/v1';
  static isNamespaced = true;
}
