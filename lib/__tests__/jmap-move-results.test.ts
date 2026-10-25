import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JMAPClient } from '../jmap/client';
import { jmapErrorFailedIds, jmapErrorProperties, jmapErrorType } from '../jmap/jmap-error';
import { DemoJMAPClient } from '../demo/demo-client';

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const response = (result: unknown) => json({ methodResponses: [['Email/set', result, '0']] });
const confirmed = (...ids: string[]) => ({ updated: Object.fromEntries(ids.map(id => [id, null])) });
const refused = { type: 'forbidden', description: 'Cannot move this message' };

function client(maxObjectsInSet = 500) {
  const result = JMAPClient.withBearer('https://move.example.invalid', 'synthetic-token', 'test@example.invalid');
  Object.assign(result, {
    accountId: 'primary', apiUrl: 'https://move.example.invalid/jmap/api',
    capabilities: { 'urn:ietf:params:jmap:core': { maxObjectsInSet } },
  });
  return result;
}

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
beforeEach(() => {
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('batch Move confirmations', () => {
  it('retains null-valued confirmations beside explicit rejections, ignoring unrequested IDs', async () => {
    fetchMock.mockResolvedValueOnce(response({ ...confirmed('a', 'unrequested'), notUpdated: { b: refused } }));
    await expect(client().batchMoveEmails(['a', 'b'], 'dest', undefined, undefined, { requireConfirmation: true })).rejects.toMatchObject({
      name: 'MoveEmailsError', confirmedIds: ['a'], rejections: { b: refused },
      unknownIds: [], unattemptedIds: [], cause: refused,
    });
  });

  it('retains all earlier chunks and the confirmations in a rejected later chunk', async () => {
    fetchMock.mockResolvedValueOnce(response(confirmed('a', 'b')))
      .mockResolvedValueOnce(response({ ...confirmed('c'), notUpdated: { d: refused } }))
      .mockResolvedValueOnce(response(confirmed('e')));
    await expect(client(2).batchMoveEmails(['a', 'b', 'c', 'd', 'e'], 'dest', undefined, undefined, { requireConfirmation: true })).rejects.toMatchObject({
      confirmedIds: ['a', 'b', 'c', 'e'], rejections: { d: refused }, unknownIds: [], unattemptedIds: [],
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('keeps a lost response unknown without replaying the write or losing earlier confirmations', async () => {
    const cause = new Error('response lost after send');
    fetchMock.mockResolvedValueOnce(response(confirmed('a'))).mockRejectedValueOnce(cause);
    await expect(client(1).batchMoveEmails(['a', 'b', 'c'], 'dest', undefined, undefined, { requireConfirmation: true })).rejects.toMatchObject({
      confirmedIds: ['a'], rejections: {}, unknownIds: ['b'], unattemptedIds: ['c'], cause,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([{}, { updated: null }, { updated: {} }, confirmed('a')])('rejects missing confirmations: %j', async result => {
    fetchMock.mockResolvedValueOnce(response(result));
    await expect(client().batchMoveEmails(['a', 'b'], 'dest', undefined, undefined, { requireConfirmation: true })).rejects.toMatchObject({
      name: 'MoveEmailsError', rejections: {}, unknownIds: 'updated' in result && result.updated != null && Object.hasOwn(result.updated, 'a') ? ['b'] : ['a', 'b'],
      unattemptedIds: [],
    });
  });

  it('does not confirm a contradictory rejected ID', async () => {
    fetchMock.mockResolvedValueOnce(response({ ...confirmed('a'), notUpdated: { a: refused } }));
    await expect(client().batchMoveEmails(['a'], 'dest', undefined, undefined, { requireConfirmation: true })).rejects.toMatchObject({ confirmedIds: [], rejections: { a: refused } });
  });

  it('reports a method refusal without inventing confirmations or dispatching later chunks', async () => {
    fetchMock.mockResolvedValueOnce(json({ methodResponses: [['error', refused, '0']] }));
    await expect(client(1).batchMoveEmails(['a', 'b'], 'dest', undefined, undefined, { requireConfirmation: true })).rejects.toMatchObject({
      confirmedIds: [], rejections: { a: refused }, unknownIds: [], unattemptedIds: ['b'], cause: refused,
    });
  });

  it.each([{ methodResponses: [] }, { methodResponses: [['Mailbox/set', confirmed('a'), '0']] },
    { methodResponses: [['Email/set', confirmed('a'), 'unrelated-call']] }])('requires a matching Email/set response: %j', async ({ methodResponses }) => {
    fetchMock.mockResolvedValueOnce(json({ methodResponses }));
    await expect(client().batchMoveEmails(['a'], 'dest', undefined, undefined, { requireConfirmation: true })).rejects.toMatchObject({ confirmedIds: [], unknownIds: ['a'] });
  });

  it('resolves only complete confirmations and preserves owner, limits, authentication and mark-read patches', async () => {
    fetchMock.mockResolvedValueOnce(response(confirmed('a'))).mockResolvedValueOnce(response(confirmed('b')));
    await expect(client(1).batchMoveEmails(['a', 'b'], 'trash', 'shared', true, { requireConfirmation: true })).resolves.toBeUndefined();
    expect(fetchMock.mock.calls.map(([url, init]) => ({
      url, auth: new Headers(init?.headers).get('Authorization'), body: JSON.parse(String(init?.body)),
    }))).toEqual(['a', 'b'].map(id => ({
      url: 'https://move.example.invalid/jmap/api', auth: 'Bearer synthetic-token',
      body: { using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'], methodCalls: [
        ['Email/set', { accountId: 'shared', update: { [id]: { mailboxIds: { trash: true }, 'keywords/$seen': true } } }, '0'],
      ] },
    })));
  });

  it('does not send an empty request', async () => {
    await expect(client().batchMoveEmails([], 'dest', undefined, undefined, { requireConfirmation: true })).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('Demo also rejects missing messages while retaining successful moves and mark-read', async () => {
    const demo = new DemoJMAPClient();
    const { emails } = await demo.getEmails();
    const id = emails[0].id;
    await expect(demo.batchMoveEmails([id, 'missing-message'], 'dest', undefined, true, { requireConfirmation: true })).rejects.toMatchObject({
      name: 'MoveEmailsError', confirmedIds: [id], rejections: { 'missing-message': { type: 'notFound' } },
      unknownIds: [], unattemptedIds: [],
    });
    const moved = await demo.getEmail(id);
    expect(moved?.mailboxIds).toEqual({ dest: true });
    expect(moved?.keywords.$seen).toBe(true);
  });
});

it('preserves upstream JMAP metadata without counting unknown or unsent IDs as confirmed', async () => {
  const rejection = { type: 'invalidProperties', properties: ['mailboxIds'] };
  fetchMock.mockResolvedValueOnce(response({ ...confirmed('a'), notUpdated: { b: rejection } }))
    .mockResolvedValueOnce(response(confirmed('c')));
  const error = await client(2).batchMoveEmails(['a', 'b', 'c', 'd', 'e'], 'dest', undefined, undefined, { requireConfirmation: true }).catch(error => error);
  expect(error).toMatchObject({ name: 'MoveEmailsError', confirmedIds: ['a', 'c'],
    rejections: { b: rejection }, unknownIds: ['d'], unattemptedIds: ['e'], cause: rejection });
  expect(jmapErrorFailedIds(error)).toEqual(['b', 'd', 'e']);
  expect(jmapErrorType(error)).toBe('invalidProperties');
  expect(jmapErrorProperties(error)).toEqual(['mailboxIds']);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it('retains an earlier refusal and confirmation when a later chunk loses its answer', async () => {
  const cause = new Error('lost after earlier refusal');
  fetchMock.mockResolvedValueOnce(response({ ...confirmed('a'), notUpdated: { b: refused } }))
    .mockRejectedValueOnce(cause);
  const error = await client(2).batchMoveEmails(['a', 'b', 'c', 'd', 'e'], 'dest', undefined, undefined, { requireConfirmation: true }).catch(error => error);
  expect(error).toMatchObject({ name: 'MoveEmailsError', confirmedIds: ['a'], rejections: { b: refused },
    unknownIds: ['c', 'd'], unattemptedIds: ['e'], cause });
  expect(jmapErrorFailedIds(error)).toEqual(['b', 'c', 'd', 'e']);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

describe('default Move contract retained for existing consumers', () => {
  it.each([{}, { updated: null }, { updated: {} }, { updated: { a: null } }])('accepts failure-free responses without complete confirmations: %j', async result => {
    fetchMock.mockImplementation(async () => response(result));
    await expect(client(2).batchMoveEmails(['a', 'b', 'c'], 'archive', 'shared', true)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([url, init]) => ({ url, auth: new Headers(init?.headers).get('Authorization'),
      body: JSON.parse(String(init?.body)) }))).toEqual([['a', 'b'], ['c']].map(ids => ({
      url: 'https://move.example.invalid/jmap/api', auth: 'Bearer synthetic-token',
      body: { using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'], methodCalls: [
        ['Email/set', { accountId: 'shared', update: Object.fromEntries(ids.map(id => [id,
          { mailboxIds: { archive: true }, 'keywords/$seen': true }])) }, '0'],
      ] },
    })));
  });

  it('preserves the original transport error and the base unsent failure set', async () => {
    const cause = new TypeError('lost response');
    fetchMock.mockResolvedValueOnce(response({ updated: {} })).mockRejectedValueOnce(cause);
    const error = await client(2).batchMoveEmails(['a', 'b', 'c', 'd', 'e'], 'trash').catch(error => error);
    expect(error).toBe(cause);
    expect(jmapErrorFailedIds(error)).toEqual(['c', 'd', 'e']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps Demo default Move and single-mode Archive tolerant of missing IDs', async () => {
    const demo = new DemoJMAPClient();
    const { emails } = await demo.getEmails();
    const id = emails[0].id;
    await expect(demo.batchMoveEmails([id, 'missing'], 'folder', undefined, true)).resolves.toBeUndefined();
    expect(await demo.getEmail(id)).toMatchObject({ mailboxIds: { folder: true }, keywords: { $seen: true } });
    await expect(demo.batchArchiveEmails([{ id, receivedAt: emails[0].receivedAt },
      { id: 'missing', receivedAt: emails[0].receivedAt }], 'archive', 'single', [])).resolves.toBeUndefined();
    expect((await demo.getEmail(id))?.mailboxIds).toEqual({ archive: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([false, true])('real Archive retains its independent confirmation contract (confirmed=%s)', async confirmed => {
    const real = client(2);
    const move = vi.spyOn(real, 'batchMoveEmails');
    fetchMock.mockResolvedValue(response({ updated: confirmed ? { a: null } : {} }));
    const operation = real.batchArchiveEmails([{ id: 'a', receivedAt: '2026-10-01T00:00:00Z' }], 'archive', 'single', []);
    if (confirmed) await expect(operation).resolves.toBeUndefined();
    else await expect(operation).rejects.toMatchObject({ name: 'ArchiveEmailsError', updatedIds: [] });
    expect(move).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
