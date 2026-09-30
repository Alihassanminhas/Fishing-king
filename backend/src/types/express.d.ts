import type { UserRole } from '../utils/auth.js';
declare global { namespace Express { interface Request { user?: { id: string; role: UserRole } } } }
export {};
