import { describe, expect, it, vi } from 'vitest';
import { removeAndConfirmStorageObjectAbsent } from './storage-object-cleanup';

const ownerId = '11111111-1111-4111-8111-111111111111';
const generationId = '22222222-2222-4222-8222-222222222222';
const assetName = '33333333-3333-4333-8333-333333333333.png';
const objectPath = `${ownerId}/${generationId}/${assetName}`;

function storageFor() {
  return {
    remove: vi.fn(async () => ({ data: [] as unknown, error: null as unknown })),
    list: vi.fn(async () => ({ data: [] as unknown, error: null as unknown })),
  };
}

describe('removeAndConfirmStorageObjectAbsent', () => {
  it('confirms only the exact object name is absent', async () => {
    const storage = storageFor();
    storage.list.mockResolvedValue({ data: [{ name: 'another-object.png' }], error: null });

    await expect(removeAndConfirmStorageObjectAbsent(storage, objectPath)).resolves.toBe(true);

    expect(storage.remove).toHaveBeenCalledExactlyOnceWith([objectPath]);
    expect(storage.list).toHaveBeenCalledExactlyOnceWith(`${ownerId}/${generationId}`, {
      search: assetName,
      limit: 2,
      offset: 0,
    });
  });

  it.each([
    { name: 'remove error', remove: { data: null, error: { status: 500 } } },
    { name: 'malformed remove result', remove: { data: null, error: null } },
  ])('does not list after a $name', async ({ remove }) => {
    const storage = storageFor();
    storage.remove.mockResolvedValue(remove);

    await expect(removeAndConfirmStorageObjectAbsent(storage, objectPath)).resolves.toBe(false);
    expect(storage.list).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'list error', data: [], error: { status: 500 } },
    { name: 'malformed list result', data: null, error: null },
    { name: 'malformed list item', data: [null], error: null },
    { name: 'object remains', data: [{ name: assetName }], error: null },
  ])('does not confirm absence after a $name', async ({ data, error }) => {
    const storage = storageFor();
    storage.list.mockResolvedValue({ data, error });

    await expect(removeAndConfirmStorageObjectAbsent(storage, objectPath)).resolves.toBe(false);
  });

  it('treats thrown Storage errors as unconfirmed removal', async () => {
    const removeFailure = storageFor();
    removeFailure.remove.mockRejectedValue(new Error('private Storage error'));
    await expect(removeAndConfirmStorageObjectAbsent(removeFailure, objectPath)).resolves.toBe(
      false,
    );
    expect(removeFailure.list).not.toHaveBeenCalled();

    const listFailure = storageFor();
    listFailure.list.mockRejectedValue(new Error('private Storage error'));
    await expect(removeAndConfirmStorageObjectAbsent(listFailure, objectPath)).resolves.toBe(false);
  });
});
