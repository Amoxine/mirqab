import 'reflect-metadata';
import { computeInSync, definitionHash, nodesInSync, type NodeView, type SyncState } from './reconcile.service';

jest.mock('@open-gateway/database', () => ({ prisma: {} }));

const view = (hash: string | null, over: Partial<NodeView> = {}): NodeView => ({
  present: hash !== null,
  hash,
  ...over,
});

describe('definitionHash', () => {
  it('is independent of key order — Tyk does not preserve it, so bytes cannot be compared', () => {
    const a = { name: 'Orders', proxy: { listen_path: '/o/', target_url: 'http://u' }, active: true };
    const b = { active: true, proxy: { target_url: 'http://u', listen_path: '/o/' }, name: 'Orders' };
    expect(definitionHash(a)).toBe(definitionHash(b));
  });

  it('changes when any managed field changes — a hand-edit on one node must be visible', () => {
    const base = { name: 'Orders', proxy: { target_url: 'http://u' } };
    expect(definitionHash(base)).not.toBe(definitionHash({ ...base, proxy: { target_url: 'http://evil' } }));
  });

  it('ignores the OAS runtime state block, which legitimately differs per node', () => {
    const withState = { 'x-tyk-api-gateway': { info: { name: 'o', state: { active: true } } } };
    const withOther = { 'x-tyk-api-gateway': { info: { name: 'o', state: { active: false } } } };
    expect(definitionHash(withState)).toBe(definitionHash(withOther));
  });

  it('ignores Tyk row identity but NOT the 12 defaults mapToTykFormat manages', () => {
    const base = { name: 'o', _id: 'x', internal_id: 'y', CORS: { enabled: false }, do_not_track: false };
    expect(definitionHash(base)).toBe(definitionHash({ ...base, _id: 'DIFFERENT', internal_id: 'ALSO' }));
    // The whole point of the small strip list: these must still register as drift.
    expect(definitionHash(base)).not.toBe(definitionHash({ ...base, do_not_track: true }));
    expect(definitionHash(base)).not.toBe(definitionHash({ ...base, CORS: { enabled: true } }));
  });

  it('does not mutate the document it hashes', () => {
    const doc = { _id: 'keep-me', name: 'o' };
    definitionHash(doc);
    expect(doc._id).toBe('keep-me');
  });

  it('distinguishes a nested value change from a nested key rename', () => {
    expect(definitionHash({ a: { b: 1 } })).not.toBe(definitionHash({ a: { c: 1 } }));
  });
});

describe('computeInSync', () => {
  it('is true only when every node answered with the same hash', () => {
    expect(computeInSync({ n1: view('h'), n2: view('h'), n3: view('h') })).toBe(true);
  });

  it('is false when one node holds a different definition', () => {
    expect(computeInSync({ n1: view('h'), n2: view('DIFFERENT') })).toBe(false);
  });

  it('is false when a node could not be read — unknown is not "in sync"', () => {
    expect(computeInSync({ n1: view('h'), n2: view(null, { error: 'ECONNREFUSED' }) })).toBe(false);
  });

  it('is false when a node is missing the definition entirely', () => {
    expect(computeInSync({ n1: view('h'), n2: { present: false, hash: null, error: 'not present' } })).toBe(false);
  });

  it('is false for an empty node map rather than vacuously true', () => {
    expect(computeInSync({})).toBe(false);
  });

  it('is true for a single-node stack, which is the default deployment', () => {
    expect(computeInSync({ only: view('h') })).toBe(true);
  });
});

describe('nodesInSync — the gauge R2 alerts on', () => {
  const state = (nodes: Record<string, NodeView>): SyncState => ({
    checkedAt: '2026-09-24T00:00:00.000Z',
    inSync: computeInSync(nodes),
    nodes,
  });

  it('counts every node when all of them hold every definition identically', () => {
    const states = [state({ n1: view('a'), n2: view('a') }), state({ n1: view('b'), n2: view('b') })];
    expect(nodesInSync(states, ['n1', 'n2'])).toBe(2);
  });

  it('drops a node that is missing one definition, and only that node', () => {
    const states = [
      state({ n1: view('a'), n2: view('a') }),
      state({ n1: view('b'), n2: { present: false, hash: null, error: 'not present' } }),
    ];
    expect(nodesInSync(states, ['n1', 'n2'])).toBe(1);
  });

  it('counts neither node when two disagree — the hashes do not say which one is right', () => {
    expect(nodesInSync([state({ n1: view('a'), n2: view('DIFFERENT') })], ['n1', 'n2'])).toBe(0);
  });

  it('equals the node count when nothing has been reconciled yet — no evidence is not drift', () => {
    expect(nodesInSync([], ['n1', 'n2', 'n3'])).toBe(3);
  });

  it('ignores a node that is no longer configured, so a removed node cannot pin the gauge low', () => {
    expect(nodesInSync([state({ n1: view('a'), retired: view(null, { error: 'gone' }) })], ['n1'])).toBe(1);
  });
});
