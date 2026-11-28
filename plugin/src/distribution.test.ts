import fs from 'fs';
import yaml from 'js-yaml';
import path from 'path';

// Each GitHub Release carries Hangar's cluster objects in three files
// (.github/scripts/cluster-bundles.sh), which distributions install as
// separate components (k4all v2.7.0 and later):
// - hangar-cluster.yaml: distribution/rbac.yaml and protection-policy.yaml;
// - hangar-node-agent.yaml: distribution/node-agent (kustomize), the
//   privileged agent, which a distribution may leave out;
// - hangar-guest-bridge.yaml: distribution/guest-bridge (kustomize), the
//   guest agent's API, which a distribution may leave out too.
// Each must apply on its own, and removing one must not take another's
// objects along: the two in hangar-system share their Namespace, and only it.

const DIST = path.resolve('..', 'distribution');

interface Rule {
  apiGroups?: string[];
  resources?: string[];
  resourceNames?: string[];
  verbs?: string[];
}

interface K8sObject {
  apiVersion: string;
  kind: string;
  metadata: { name: string; namespace?: string; labels?: Record<string, string> };
  rules?: Rule[];
  aggregationRule?: { clusterRoleSelectors: { matchLabels: Record<string, string> }[] };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  spec?: any;
}

function objects(file: string): K8sObject[] {
  return (yaml.loadAll(fs.readFileSync(path.join(DIST, file), 'utf8')) as K8sObject[]).filter(Boolean);
}

// The objects of a kustomization, with its `namespace:` if it has one.
function kustomized(dir: string): K8sObject[] {
  const k = yaml.load(fs.readFileSync(path.join(DIST, dir, 'kustomization.yaml'), 'utf8')) as {
    namespace?: string;
    resources: string[];
  };
  return k.resources.flatMap(r =>
    objects(path.join(dir, r)).map(o =>
      k.namespace === undefined
        ? o
        : { ...o, metadata: { ...o.metadata, namespace: o.kind === 'Namespace' ? undefined : k.namespace } }
    )
  );
}

const nodeAgentObjects = () => kustomized('node-agent');
const bridgeObjects = () => kustomized('guest-bridge');

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

function find(list: K8sObject[], kind: string, name: string): K8sObject {
  const o = list.find(x => x.kind === kind && x.metadata.name === name);
  if (!o) throw new Error(`no ${kind} ${name}`);
  return o;
}

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

  it('the guest bridge carries its server, its API and its access', () => {
    expect(bridgeObjects().map(key).sort()).toEqual(
      [
        'APIService /v1alpha1.subresources.hangar.magesgate.com',
        'ClusterRole /hangar-guest-bridge',
        'ClusterRoleBinding /hangar-guest-bridge',
        'ClusterRoleBinding /hangar-guest-bridge:auth-delegator',
        'DaemonSet hangar-system/hangar-guest-bridge',
        'Namespace /hangar-system',
        'Role hangar-system/hangar-guest-bridge',
        'RoleBinding hangar-system/hangar-guest-bridge',
        'RoleBinding kube-system/hangar-guest-bridge:extension-apiserver-authentication-reader',
        'Service hangar-system/hangar-guest-bridge',
        'ServiceAccount hangar-system/hangar-guest-bridge',
      ].sort()
    );
  });

  it('no object is in two bundles but the shared Namespace, which is the same in both', () => {
    const agent = nodeAgentObjects();
    const bridge = bridgeObjects();
    const shared = (a: K8sObject[], b: K8sObject[]) => {
      const keys = new Set(b.map(key));
      return a.map(key).filter(k => keys.has(k));
    };
    expect(shared(cluster, agent)).toEqual([]);
    expect(shared(cluster, bridge)).toEqual([]);
    expect(shared(agent, bridge)).toEqual(['Namespace /hangar-system']);
    expect(find(bridge, 'Namespace', 'hangar-system')).toEqual(find(agent, 'Namespace', 'hangar-system'));
  });

  it("the bridge's objects but the Namespace carry its name label (removal by label keeps the Namespace)", () => {
    const unlabelled = bridgeObjects()
      .filter(o => o.metadata.labels?.['app.kubernetes.io/name'] !== 'hangar-guest-bridge')
      .map(key);
    expect(unlabelled).toEqual(['Namespace /hangar-system']);
  });
});

describe('the guest bridge bundle', () => {
  const bridge = bridgeObjects();
  const ds = find(bridge, 'DaemonSet', 'hangar-guest-bridge');
  const pod = ds.spec.template.spec;
  const container = pod.containers[0];

  it('ships the APIService without a caBundle: the bridge sets it', () => {
    const api = find(bridge, 'APIService', 'v1alpha1.subresources.hangar.magesgate.com');
    expect(api.spec).toMatchObject({
      group: 'subresources.hangar.magesgate.com',
      version: 'v1alpha1',
      service: { namespace: 'hangar-system', name: 'hangar-guest-bridge', port: 443 },
    });
    expect(api.spec.caBundle).toBeUndefined();
    expect(api.spec.insecureSkipTLSVerify).toBeUndefined();
  });

  it("the Service reaches the bridge's port 8443 on ready pods", () => {
    const svc = find(bridge, 'Service', 'hangar-guest-bridge');
    expect(svc.spec.selector).toEqual({ 'app.kubernetes.io/name': 'hangar-guest-bridge' });
    expect(ds.spec.template.metadata.labels).toMatchObject(svc.spec.selector);
    const port = svc.spec.ports.find((p: { port: number }) => p.port === 443);
    const target = container.ports.find((p: { name: string }) => p.name === port.targetPort);
    expect(target.containerPort).toBe(8443);
    expect(container.readinessProbe.httpGet).toEqual({ path: '/readyz', port: 'https', scheme: 'HTTPS' });
    expect(svc.spec.publishNotReadyAddresses).toBeFalsy();
  });

  it('runs on every host with the profile the prototype measured', () => {
    expect(pod.tolerations).toEqual([{ operator: 'Exists' }]);
    expect(pod.serviceAccountName).toBe('hangar-guest-bridge');
    expect(pod.securityContext).toMatchObject({ runAsUser: 0, seLinuxOptions: { type: 'spc_t' } });
    expect(container.securityContext).toEqual({
      privileged: false,
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      capabilities: { drop: ['ALL'], add: ['DAC_OVERRIDE'] },
    });
    expect(container.resources).toEqual({ requests: { cpu: '10m', memory: '64Mi' }, limits: { memory: '128Mi' } });
    expect(container.image).toMatch(/^ghcr\.io\/kalik1\/hangar-guest-bridge:\d+\.\d+\.\d+$/);
  });

  it('mounts the kubelet pods read-only, and the peer token of audience hangar-guest-bridge', () => {
    const mounts = Object.fromEntries(
      container.volumeMounts.map((m: { name: string; mountPath: string; readOnly?: boolean }) => [m.name, m])
    );
    const volumes = Object.fromEntries(pod.volumes.map((v: { name: string }) => [v.name, v]));
    expect(mounts['kubelet-pods']).toEqual({ name: 'kubelet-pods', mountPath: '/var/lib/kubelet/pods', readOnly: true });
    expect(volumes['kubelet-pods'].hostPath).toEqual({ path: '/var/lib/kubelet/pods', type: 'Directory' });
    expect(Object.keys(mounts).sort()).toEqual(['kubelet-pods', 'peer-token']);
    // The bridge reads /var/run/secrets/hangar-guest-bridge/token.
    expect(mounts['peer-token'].mountPath).toBe('/var/run/secrets/hangar-guest-bridge');
    expect(volumes['peer-token'].projected.sources).toEqual([
      { serviceAccountToken: { audience: 'hangar-guest-bridge', expirationSeconds: 3600, path: 'token' } },
    ]);
  });

  it('gives the bridge its node, pod name and namespace', () => {
    const env = Object.fromEntries(
      container.env.map((e: { name: string; valueFrom: { fieldRef: { fieldPath: string } } }) => [
        e.name,
        e.valueFrom.fieldRef.fieldPath,
      ])
    );
    expect(env).toEqual({ NODE_NAME: 'spec.nodeName', POD_NAME: 'metadata.name', POD_NAMESPACE: 'metadata.namespace' });
  });

  it('lets the bridge get and patch its one APIService, and no other', () => {
    const rules = find(bridge, 'ClusterRole', 'hangar-guest-bridge').rules ?? [];
    const api = rules.filter(r => r.apiGroups?.includes('apiregistration.k8s.io'));
    expect(api).toEqual([
      {
        apiGroups: ['apiregistration.k8s.io'],
        resources: ['apiservices'],
        resourceNames: ['v1alpha1.subresources.hangar.magesgate.com'],
        verbs: ['get', 'patch'],
      },
    ]);
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

  it('the guest bridge reads and changes only its own Secret', () => {
    const grants = bridgeObjects().flatMap(o =>
      (o.rules ?? [])
        .filter(r => (r.apiGroups ?? []).includes('') && (r.resources ?? []).some(x => x === 'secrets' || x === '*'))
        .map(r => `${key(o)}: ${(r.verbs ?? []).join(',')} ${(r.resourceNames ?? ['*']).join(',')}`)
    );
    expect(grants).toEqual([
      'Role hangar-system/hangar-guest-bridge: create *',
      'Role hangar-system/hangar-guest-bridge: get,update hangar-guest-bridge-tls',
    ]);
  });
});

describe("the guest bridge's user roles", () => {
  const roles = objects('rbac.yaml');
  const grants = (name: string) =>
    (find(roles, 'ClusterRole', name).rules ?? []).filter(r =>
      r.apiGroups?.includes('subresources.hangar.magesgate.com')
    );

  it('hangar-viewer reads guestinfo, nothing else of the bridge', () => {
    expect(grants('hangar-viewer')).toEqual([
      { apiGroups: ['subresources.hangar.magesgate.com'], resources: ['virtualmachineinstances/guestinfo'], verbs: ['get'] },
    ]);
  });

  it('hangar-guest-admin has guestfiles with its four verbs, and is aggregated into no other role', () => {
    const admin = find(roles, 'ClusterRole', 'hangar-guest-admin');
    expect(grants('hangar-guest-admin')).toEqual([
      {
        apiGroups: ['subresources.hangar.magesgate.com'],
        resources: ['virtualmachineinstances/guestfiles'],
        verbs: ['get', 'create', 'update', 'delete'],
      },
    ]);
    expect(admin.metadata.labels ?? {}).toEqual({});
    const others = roles.filter(r => r.kind === 'ClusterRole' && r.metadata.name !== 'hangar-guest-admin');
    expect(
      others.flatMap(r => (r.rules ?? []).filter(x => x.resources?.some(res => res.includes('guestfiles')))).length
    ).toBe(0);
  });
});
