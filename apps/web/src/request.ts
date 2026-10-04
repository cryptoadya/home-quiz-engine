export class RequestError extends Error {
  constructor(message: string, readonly status?: number) { super(message); }
}

export async function request<T = void>(path: string, options?: RequestInit): Promise<T> {
  let response: Response;
  try { response = await fetch(path, options); }
  catch { throw new RequestError('Не удалось связаться с сервером. Проверьте соединение и повторите действие.'); }
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new RequestError(typeof body?.error === 'string' ? body.error : `Ошибка запроса (${response.status}). Повторите действие.`, response.status);
  }
  if (response.status === 204) return undefined as T;
  try { return await response.json() as T; }
  catch { throw new RequestError('Сервер вернул некорректный ответ. Повторите действие.', response.status); }
}
