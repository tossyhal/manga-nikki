import { api } from './client';

export const getAssetUrl = (id: string) =>
  api<{ url: string; expiresAt: string }>(`/assets/${encodeURIComponent(id)}/url`);
