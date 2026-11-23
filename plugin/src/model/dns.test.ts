import { describe, expect, it } from 'vitest';
import { applyDns, dnsOf, dnsProblems, effectiveDns, hostSearchHint, isDefaultDns, parseKubeletDns, setDns, splitList, usesPodNetwork } from './dns';

const vm = (spec: any = {}) => ({ metadata: { name: 'web', namespace: 'prod' }, spec: { template: { spec } } }) as any;
const cluster = { servers: ['10.96.0.10'], domain: 'cluster.local' };

describe('dnsOf / setDns', () => {
  it('reads the defaults', () => {
    expect(dnsOf(vm())).toEqual({ policy: 'ClusterFirst', nameservers: [], searches: [] });
    expect(isDefaultDns(dnsOf(vm()))).toBe(true);
  });
  it('treats unknown policies as ClusterFirst', () => {
    expect(dnsOf(vm({ dnsPolicy: 'ClusterFirstWithHostNet' })).policy).toBe('ClusterFirst');
  });
  it('writes only what differs from the defaults and keeps options', () => {
    const v = vm({ dnsConfig: { options: [{ name: 'ndots', value: '2' }] } });
    const next = setDns(v, { policy: 'None', nameservers: ['1.1.1.1'], searches: ['corp.example'] });
    expect(next.spec.template.spec.dnsPolicy).toBe('None');
    expect(next.spec.template.spec.dnsConfig).toEqual({ nameservers: ['1.1.1.1'], searches: ['corp.example'], options: [{ name: 'ndots', value: '2' }] });
    expect(v.spec.template.spec.dnsPolicy).toBeUndefined();
    const back = setDns(next, { policy: 'ClusterFirst', nameservers: [], searches: [] });
    expect(back.spec.template.spec.dnsPolicy).toBeUndefined();
    expect(back.spec.template.spec.dnsConfig).toEqual({ options: [{ name: 'ndots', value: '2' }] });
  });
  it('drops an empty dnsConfig', () => {
    const t: any = { dnsConfig: { nameservers: ['8.8.8.8'] } };
    applyDns(t, { policy: 'ClusterFirst', nameservers: [], searches: [] });
    expect(t.dnsConfig).toBeUndefined();
  });
});

describe('dnsProblems', () => {
  it('accepts a sane config', () => {
    expect(dnsProblems({ policy: 'ClusterFirst', nameservers: ['192.0.2.53'], searches: ['example.com'] })).toEqual([]);
  });
  it('wants addresses and domains', () => {
    const p = dnsProblems({ policy: 'Default', nameservers: ['dns.google'], searches: ['bad domain!'] });
    expect(p.join(' ')).toMatch(/Not an IP address: dns.google/);
    expect(p.join(' ')).toMatch(/Not a domain name/);
  });
  it('needs a server with None', () => {
    expect(dnsProblems({ policy: 'None', nameservers: [], searches: [] })[0]).toMatch(/at least one DNS server/);
  });
  it('counts the cluster DNS in the limit of three', () => {
    expect(dnsProblems({ policy: 'ClusterFirst', nameservers: ['1.1.1.1', '8.8.8.8'], searches: [] })).toEqual([]);
    expect(dnsProblems({ policy: 'ClusterFirst', nameservers: ['1.1.1.1', '8.8.8.8', '9.9.9.9'], searches: [] })[0]).toMatch(/At most 2 extra/);
    expect(dnsProblems({ policy: 'None', nameservers: ['1.1.1.1', '8.8.8.8', '9.9.9.9'], searches: [] })).toEqual([]);
  });
  it('accepts IPv6 servers', () => {
    expect(dnsProblems({ policy: 'None', nameservers: ['2001:4860:4860::8888'], searches: [] })).toEqual([]);
  });
});

describe('effectiveDns', () => {
  it('mirrors the kubelet for ClusterFirst', () => {
    const e = effectiveDns({ policy: 'ClusterFirst', nameservers: ['192.0.2.53'], searches: ['corp.example'] }, 'prod', cluster, ['example.com']);
    expect(e.servers).toEqual([
      { address: '10.96.0.10', from: 'cluster' },
      { address: '192.0.2.53', from: 'vm' },
    ]);
    expect(e.searches.map(x => x.domain)).toEqual(['prod.svc.cluster.local', 'svc.cluster.local', 'cluster.local', 'example.com', 'corp.example']);
    expect(e.hostPart).toBe(true);
  });
  it('uses only the VM settings with None', () => {
    const e = effectiveDns({ policy: 'None', nameservers: ['1.1.1.1'], searches: ['a.example.'] }, 'prod', cluster, ['example.com']);
    expect(e.servers.map(x => x.address)).toEqual(['1.1.1.1']);
    expect(e.searches.map(x => x.domain)).toEqual(['a.example']);
    expect(e.hostPart).toBe(false);
  });
  it('keeps the host part for Default and drops servers past three', () => {
    const e = effectiveDns({ policy: 'Default', nameservers: ['1.1.1.1', '2.2.2.2', '3.3.3.3', '4.4.4.4'], searches: [] }, 'prod', cluster, ['example.com']);
    expect(e.searches.map(x => x.domain)).toEqual(['example.com']);
    expect(e.dropped).toEqual(['4.4.4.4']);
  });
});

describe('helpers', () => {
  it('splits lists', () => {
    expect(splitList(' 1.1.1.1, 8.8.8.8 1.1.1.1;9.9.9.9 ')).toEqual(['1.1.1.1', '8.8.8.8', '9.9.9.9']);
  });
  it('finds the node domain', () => {
    expect(hostSearchHint([{ metadata: { name: 'a.example.com' } }, { metadata: { name: 'b.example.com' } }] as any)).toEqual(['example.com']);
    expect(hostSearchHint([{ metadata: { name: 'a.example.com' } }, { metadata: { name: 'b' } }] as any)).toEqual([]);
  });
  it('sees the pod network', () => {
    expect(usesPodNetwork(vm({ networks: [{ name: 'default', pod: {} }] }))).toBe(true);
    expect(usesPodNetwork(vm({ networks: [{ name: 'lan', multus: { networkName: 'x/y' } }] }))).toBe(false);
  });
});

describe('parseKubeletDns', () => {
  it('reads the block form kubeadm writes', () => {
    const y = 'apiVersion: kubelet.config.k8s.io/v1beta1\nclusterDNS:\n- 10.96.0.10\nclusterDomain: cluster.local\ncgroupDriver: systemd\n';
    expect(parseKubeletDns(y)).toEqual({ servers: ['10.96.0.10'], domain: 'cluster.local' });
  });
  it('reads the inline form', () => {
    expect(parseKubeletDns('clusterDNS: ["169.254.20.10", 10.96.0.10]\nclusterDomain: "corp.local"\n')).toEqual({ servers: ['169.254.20.10', '10.96.0.10'], domain: 'corp.local' });
  });
  it('gives up on unrelated text', () => {
    expect(parseKubeletDns('foo: bar')).toBeNull();
  });
});
