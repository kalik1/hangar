import fs from 'fs';
import yaml from 'js-yaml';
import path from 'path';

// Each GitHub Release carries Hangar's cluster objects in two files
// (.github/scripts/cluster-bundles.sh), which distributions install as two
// separate components (k4all v2.7.0 and later):
// - hangar-cluster.yaml: distribution/rbac.yaml and protection-policy.yaml;
// - hangar-node-agent.yaml: distribution/node-agent (kustomize), the
//   privileged agent, which a distribution may leave out.
// Each must apply on its own, and removing one must not take the other's
// objects along.

const DIST = path.resolve('..', 'distribution');

interface K8sObject {
  kind: string;
  metadata: { name: string; namespace?: string };
  rules?: { apiGroups?: string[]; resources?: string[]; verbs?: string[] }[];
}

function objects(file: string): K8sObject[] {
  return (yaml.loadAll(fs.readFileSync(path.join(DIST, file), 'utf8')) as K8sObject[]).filter(Boolean);
}

function nodeAgentObjects(): K8sObject[] {
  const k = yaml.load(fs.readFileSync(path.join(DIST, 'node-agent', 'kustomization.yaml'), 'utf8')) as {
    namespace: string;
    resources: string[];
  };
  return k.resources.flatMap(r => objects(path.join('node-agent', r)).map(o => ({
    ...o,
    metadata: { ...o.metadata, namespace: o.kind === 'Namespace' ? undefined : k.namespace },
  })));
}

const key = (o: K8sObject) => `${o.kind} ${o.metadata.namespace ?? ''}/${o.metadata.name}`;

/** The verbs a role grants on group/resource. */
function verbs(role: string, group: string, resource: string): string[] {
  const o = objects('rbac.yaml').find(x => x.metadata.name === role);
  return (o?.rules ?? [])
    .filter(r => (r.apiGroups ?? []).includes(group) && (r.resources ?? []).includes(resource))
    .flatMap(r => r.verbs ?? [])
    .sort();
}

describe('roles for published ports', () => {
  it('the viewer reads Services, EndpointSlices, Events and the address pools', () => {
    expect(verbs('hangar-viewer', '', 'services')).toEqual(['get', 'list', 'watch']);
    expect(verbs('hangar-viewer', 'discovery.k8s.io', 'endpointslices')).toEqual(['get', 'list', 'watch']);
    expect(verbs('hangar-viewer', '', 'events')).toEqual(['get', 'list', 'watch']);
    expect(verbs('hangar-viewer', 'metallb.io', 'ipaddresspools')).toEqual(['get', 'list']);
    expect(verbs('hangar-viewer', 'cilium.io', 'ciliumloadbalancerippools')).toEqual(['get', 'list']);
  });
  it('the VM operator creates, patches and deletes Services', () => {
    expect(verbs('hangar-vm-operator-rules', '', 'services')).toEqual(['create', 'delete', 'patch']);
  });
  it('web addresses: the viewer reads Ingresses, classes, Certificates and issuers; the VM operator writes Ingresses', () => {
    for (const r of ['ingresses', 'ingressclasses']) expect(verbs('hangar-viewer', 'networking.k8s.io', r)).toEqual(['get', 'list', 'watch']);
    for (const r of ['certificates', 'issuers', 'clusterissuers']) expect(verbs('hangar-viewer', 'cert-manager.io', r)).toEqual(['get', 'list', 'watch']);
    expect(verbs('hangar-vm-operator-rules', 'networking.k8s.io', 'ingresses')).toEqual(['create', 'delete', 'patch']);
  });
  // Still no Secret read: 'roles and Secrets' below.
});

describe('cluster bundles', () => {
  const cluster = [...objects('rbac.yaml'), ...objects('protection-policy.yaml')];

  it('hangar-cluster.yaml puts nothing in the node agent namespace', () => {
    expect(cluster.filter(o => o.metadata.namespace === 'hangar-system').map(key)).toEqual([]);
  });

  it('the node agent carries what host devices need in hangar-system', () => {
    const agent = nodeAgentObjects().map(key);
    expect(agent).toContain('Namespace /hangar-system');
    expect(agent).toContain('DaemonSet hangar-system/hangar-node-agent');
    expect(agent).toContain('Role hangar-system/hangar-hardware-admin');
  });

  it('no object is in both bundles', () => {
    const agent = new Set(nodeAgentObjects().map(key));
    expect(cluster.map(key).filter(k => agent.has(k))).toEqual([]);
  });
});

describe('roles and Secrets', () => {
  it('only hangar-vm-admin may create Secrets (cloud-init user data); no role reads, lists, watches or changes them', () => {
    const grants = [...objects('rbac.yaml'), ...nodeAgentObjects()].flatMap(o =>
      (o.rules ?? [])
        .filter(r => (r.apiGroups ?? []).includes('') && (r.resources ?? []).some(x => x === 'secrets' || x === '*'))
        .map(r => `${o.metadata.name}: ${(r.verbs ?? []).join(',')}`)
    );
    expect(grants).toEqual(['hangar-vm-admin-rules: create']);
  });
});
