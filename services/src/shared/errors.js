export class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message, details) => new AppError(400, 'BAD_REQUEST', message, details);
export const unauthorized = (message = 'Missing or invalid token') => new AppError(401, 'UNAUTHORIZED', message);
export const forbidden = (message = 'You are not allowed to do this', code = 'FORBIDDEN') => new AppError(403, code, message);
export const notFound = (what = 'Not found') => new AppError(404, 'NOT_FOUND', what);
export const conflict = (code, message, details) => new AppError(409, code, message, details);
