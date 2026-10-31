export class AppError extends Error {
  constructor(public code: string, message: string, public statusCode = 400) { super(message); }
}
export function messageOf(error: unknown) { return error instanceof Error ? error.message : '操作失败'; }
