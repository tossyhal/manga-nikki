function isRequestInput(input: RequestInfo | URL): input is Request {
  return typeof input === 'object' && input !== null && 'headers' in input;
}

export function createSupabaseApiKeyFetch(
  apiKey: string,
  fetcher: typeof fetch = fetch,
): typeof fetch {
  if (!apiKey.startsWith('sb_publishable_') && !apiKey.startsWith('sb_secret_')) return fetcher;

  return (input, init) => {
    const headers =
      init?.headers !== undefined
        ? new Headers(init.headers)
        : isRequestInput(input)
          ? new Headers(input.headers)
          : new Headers();

    if (headers.get('apikey') !== apiKey || headers.get('authorization') !== `Bearer ${apiKey}`)
      return fetcher(input, init);

    headers.delete('authorization');
    return fetcher(input, { ...init, headers });
  };
}
