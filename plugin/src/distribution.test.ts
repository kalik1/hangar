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
