export class ApiError extends Error {
  constructor(
    public status: 400 | 401 | 403 | 404 | 409 | 413 | 429 | 503,
    public code: string,
  ) {
    super(code);
  }
}
export const messages: Record<string, string> = {
  INVALID_INPUT: '入力内容を確認してください。',
  AUTH_REQUIRED: '認証情報を確認してください。',
  CONSENT_REQUIRED: '利用への同意を確認してください。',
  NOT_FOUND: '記録が見つかりません。',
  REVISION_CONFLICT: '記録が更新されています。再読み込みしてください。',
  REVISION_ALREADY_GENERATED:
    'この改訂版の漫画はすでに保存されています。最新の状態を読み込んでください。',
  ENTRY_BUSY: '生成中の記録は編集できません。',
  IDEMPOTENCY_CONFLICT: '同じ操作IDで異なる内容は送信できません。',
  INPUT_TOO_LARGE: '入力サイズが大きすぎます。',
  USER_LIMIT_REACHED: '本日の生成上限に達しました。',
  GLOBAL_LIMIT_REACHED: '現在、生成の上限に達しています。',
  TOO_MANY_ACTIVE: '生成中の記録があります。完了後にもう一度お試しください。',
  CAPTCHA_FAILED: '確認に失敗しました。新しい確認を行ってください。',
  DRAFT_LIMIT_REACHED: '下書きが上限に達しました。不要な記録を削除してください。',
  ENTRY_CREATE_RATE_LIMIT_REACHED: '本日の記録作成上限に達しました。明日以降にお試しください。',
  ENTRY_RETAINED_LIMIT_REACHED:
    '未回収の記録が上限に達しました。削除済みの記録が回収された後にお試しください。',
  DEPENDENCY_UNAVAILABLE: '一時的に利用できません。時間をおいて再操作してください。',
  GENERATION_DISABLED: 'この環境では個人データの操作は利用できません。',
};
export async function jsonBody(request: Request): Promise<unknown> {
  if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json')
    throw new ApiError(400, 'INVALID_INPUT');
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(400, 'INVALID_INPUT');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 16384) {
        await reader.cancel();
        throw new ApiError(413, 'INPUT_TOO_LARGE');
      }
      chunks.push(part.value);
    }
    const data = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      data.set(chunk, offset);
      offset += chunk.length;
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data));
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, 'INVALID_INPUT');
  } finally {
    reader.releaseLock();
  }
}
