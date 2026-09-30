# Cast & Current

A responsive fishing gear store starter with a React storefront, Express API, PostgreSQL persistence, secure cookie authentication, and Stripe Checkout Elements.

## Requirements

- Node.js 20+
- PostgreSQL (Neon is supported)
- Stripe test keys to enable online checkout

## Local setup

1. Copy `.env.example` to `.env` and set `DATABASE_URL` and a random `JWT_SECRET` with at least 32 characters. Add Stripe test keys for payments and Cloudinary credentials for admin image uploads. Keep database, Stripe, and Cloudinary secrets server-side.
2. Install dependencies with `npm install`.
3. Apply the schema and sample catalog: `npm run db:migrate`, then `npm run db:seed`.
4. Start the frontend and API together: `npm run dev`.
5. Visit `http://localhost:5173`. Create an admin with `npm run admin:create -- "Store Admin" admin@example.com "a-long-password-12"`.

The API listens on port 4000. The Vite development server proxies `/api` to it. Set both Stripe keys and `STRIPE_WEBHOOK_SECRET` to use online checkout. Set `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, and `CLOUDINARY_API_SECRET` to enable admin product image uploads. For local webhook testing, forward Stripe events to `http://localhost:4000/api/payments/webhook`.

## API overview

- Public: `GET /api/health`, `GET /api/csrf`, `GET /api/products`, `GET /api/products/:slug`, `GET /api/categories`
- Auth: `POST /api/auth/register`, `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`
- Customer: `GET /api/cart`, `POST /api/cart/items`, `PATCH|DELETE /api/cart/items/:productId`, `POST /api/checkout`, `GET /api/orders`, `GET /api/orders/:id`
- Admin: `/api/admin/products`, `/api/admin/categories`, `/api/admin/orders`, `/api/admin/customers`
- Stripe: `POST /api/payments/webhook`

State-changing browser requests require a CSRF token from `GET /api/csrf`; the frontend API client handles this automatically. Sessions use an HttpOnly cookie. Stripe webhooks use signature verification and an event-id ledger for idempotency.

## Deployment

Deploy the repository as one Vercel project with the root directory selected. The Vite output is `frontend/dist`; `/api/*` routes to the serverless Express handler. Configure `DATABASE_URL`, `JWT_SECRET`, `FRONTEND_URL`, `SHIPPING_FEE_CENTS`, Stripe keys, and Cloudinary credentials in Vercel. Configure `VITE_API_URL=/api` and `VITE_STRIPE_PUBLISHABLE_KEY` as build-time frontend variables. Run migrations against Neon before serving traffic. Restrict `FRONTEND_URL` to the deployed site origin(s).

`npm run typecheck` and `npm run build` validate the project. Stripe payments are disabled until server and publishable test keys are set.
