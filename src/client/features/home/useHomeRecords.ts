import { useEffect, useState } from 'react';
import type { Entry } from '../../../shared/schemas';
import { ApiClientError, getEntries } from '../../lib/api';
import type { ClientConfig } from '../../lib/config';
import { useOnlineStatus } from '../../lib/useOnlineStatus';

type HomeRecords =
  | { status: 'loading' }
  | { status: 'sample' }
  | { status: 'ready'; entries: Entry[] }
  | { status: 'error'; message: string };

function isMissingLocalSession(error: unknown): boolean {
  return (
    error instanceof ApiClientError &&
    error.status === 401 &&
    error.code === 'AUTH_REQUIRED' &&
    error.requestId === null
  );
}

export function useHomeRecords(
  config: ClientConfig | null,
  configError: boolean,
  retryKey: number,
): HomeRecords {
  const { online } = useOnlineStatus();
  const [loaded, setLoaded] = useState<{
    config: ClientConfig | null;
    configError: boolean;
    retryKey: number;
    records: HomeRecords;
  }>({ config: null, configError: false, retryKey: -1, records: { status: 'loading' } });
  const records =
    configError || config?.dataMode === 'sample' || (config !== null && !online)
      ? { status: 'sample' as const }
      : !config
        ? { status: 'loading' as const }
        : loaded.config === config &&
            loaded.configError === configError &&
            loaded.retryKey === retryKey
          ? loaded.records
          : { status: 'loading' as const };

  useEffect(() => {
    if (configError || !config || config.dataMode === 'sample' || !online) return;
    const currentConfig = config;
    let active = true;
    async function loadEntries() {
      let receivedBackgroundUpdate = false;
      try {
        const result = await getEntries({
          limit: 20,
          fresh: retryKey > 0,
          onUpdate: (latest) => {
            if (!active) return;
            receivedBackgroundUpdate = true;
            setLoaded({
              config: currentConfig,
              configError,
              retryKey,
              records: { status: 'ready', entries: latest.items },
            });
          },
          onBackgroundError: (failure) => {
            if (!active || !(failure instanceof ApiClientError)) return;
            if (failure.status !== 401 && failure.status !== 403) return;
            receivedBackgroundUpdate = true;
            setLoaded({
              config: currentConfig,
              configError,
              retryKey,
              records: isMissingLocalSession(failure)
                ? { status: 'ready', entries: [] }
                : { status: 'error', message: failure.message },
            });
          },
        });
        if (active && !receivedBackgroundUpdate)
          setLoaded({
            config: currentConfig,
            configError,
            retryKey,
            records: { status: 'ready', entries: result.items },
          });
      } catch (failure) {
        if (active)
          setLoaded({
            config: currentConfig,
            configError,
            retryKey,
            records: !navigator.onLine
              ? { status: 'sample' }
              : isMissingLocalSession(failure)
                ? { status: 'ready', entries: [] }
                : {
                    status: 'error',
                    message:
                      failure instanceof Error ? failure.message : '通信を確認してください。',
                  },
          });
      }
    }
    void loadEntries();
    return () => {
      active = false;
    };
  }, [config, configError, online, retryKey]);
  return records;
}
