import 'dotenv/config';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { HttpError } from './errors.js';

export type UserRole = 'customer' | 'admin';
const secret = process.env.JWT_SECRET;
if (!secret || secret.length < 32) throw new Error('JWT_SECRET must contain at least 32 characters.');
const cookieBase = { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax' as const, path: '/' };
export function createCsrfToken(): string { return randomBytes(32).toString('hex'); }
export function setSession(response: Response, user: { id: string; role: UserRole }): void {
  const token = jwt.sign({ role: user.role }, secret!, { subject: user.id, expiresIn: '2h', issuer: 'fishing-store' });
  response.cookie('session', token, { ...cookieBase, maxAge: 2 * 60 * 60 * 1000 });
}
export function clearSession(response: Response): void { response.clearCookie('session', cookieBase); }
export function csrfProtection(request: Request, _response: Response, next: NextFunction): void {
  // Stripe authenticates provider calls with its signed raw request body.
  if (request.path === '/payments/webhook') return next();
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return next();
  const cookie = request.cookies?.csrf;
  const header = request.header('x-csrf-token');
  if (!cookie || !header || cookie.length !== header.length || !timingSafeEqual(Buffer.from(cookie), Buffer.from(header))) return next(new HttpError(403, 'Your session security token is missing or expired. Refresh and try again.'));
  next();
}
export function requireAuth(request: Request, _response: Response, next: NextFunction): void {
  const token = request.cookies?.session as string | undefined;
  if (!token) return next(new HttpError(401, 'Please sign in to continue.'));
  try {
    const payload = jwt.verify(token, secret!, { issuer: 'fishing-store' });
    if (typeof payload === 'string' || !payload.sub || (payload.role !== 'customer' && payload.role !== 'admin')) throw new Error('Invalid claims');
    request.user = { id: payload.sub, role: payload.role };
    next();
  } catch { next(new HttpError(401, 'Your session has expired. Please sign in again.')); }
}
export function requireAdmin(request: Request, _response: Response, next: NextFunction): void {
  if (request.user?.role !== 'admin') return next(new HttpError(403, 'Administrator access is required.'));
  next();
}
