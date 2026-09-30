import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';

export class HttpError extends Error {
  constructor(public readonly status: number, message: string) { super(message); this.name = 'HttpError'; }
}
export const errorHandler: ErrorRequestHandler = (error: unknown, _request, response, _next) => {
  const status = error instanceof HttpError ? error.status : error instanceof ZodError ? 400 : 500;
  const message = error instanceof HttpError ? error.message : error instanceof ZodError ? error.issues[0]?.message ?? 'Please check the submitted details.' : 'Something went wrong. Please try again.';
  if (status >= 500) console.error('Request failed:', error instanceof Error ? error.message : error);
  response.status(status).json({ error: message });
};
