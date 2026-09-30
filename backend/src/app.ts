import 'dotenv/config';
import express, { type Request, type Response, type NextFunction } from 'express';
import { createHash, randomUUID } from 'node:crypto';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import Stripe from 'stripe';
import { z } from 'zod';
import { pool } from './db/pool.js';
import { clearSession, createCsrfToken, csrfProtection, requireAdmin, requireAuth, setSession } from './utils/auth.js';
import { errorHandler, HttpError } from './utils/errors.js';

const app = express();
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const frontendOrigins = (process.env.FRONTEND_URL ?? 'http://localhost:5173').split(',').map((origin) => origin.trim());
const asyncRoute = (handler: (request: Request, response: Response, next: NextFunction) => Promise<unknown>) =>
  (request: Request, response: Response, next: NextFunction) => { void handler(request, response, next).catch(next); };

app.disable('x-powered-by');
app.use(helmet());
app.use(cors({ origin(origin, callback) { if (!origin || frontendOrigins.includes(origin)) return callback(null, true); callback(new HttpError(403, 'This website is not allowed to access the API.')); }, credentials: true }));
app.use('/api/payments/webhook', express.raw({ type: 'application/json', limit: '1mb' }));
app.use(express.json({ limit: '32kb' }));
app.use(cookieParser());
app.use('/api', csrfProtection);

const fail = (status: number, message: string): never => { throw new HttpError(status, message); };
const uuid = z.string().uuid();
const authSchema = z.object({ name: z.string().trim().min(1).max(120).optional(), email: z.email().max(254), password: z.string().min(10).max(128) });
const productSchema = z.object({ name: z.string().trim().min(2).max(160), slug: z.string().trim().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/), description: z.string().max(5000).default(''), priceCents: z.number().int().min(0).max(10_000_000), stock: z.number().int().min(0).max(100_000), lowStockThreshold: z.number().int().min(0).max(100_000).default(5), categoryId: uuid, active: z.boolean().default(true), featured: z.boolean().default(false), imageUrl: z.url().max(2000).optional(), imageAlt: z.string().max(250).default('') });
const categorySchema = z.object({ name: z.string().trim().min(2).max(100), slug: z.string().trim().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/), description: z.string().max(1000).default('') });
const productSelect = `p.id,p.name,p.slug,p.description,p.price_cents AS "priceCents",p.stock,p.low_stock_threshold AS "lowStockThreshold",
  p.featured,p.category_id AS "categoryId",c.name AS "categoryName",c.slug AS "categorySlug",p.active,
  (SELECT json_agg(json_build_object('url',i.url,'alt',i.alt_text) ORDER BY i.position) FROM product_images i WHERE i.product_id=p.id) AS images`;
const maxPriceCents = 2_147_483_647;
const getShippingFeeCents = (): number => {
  const parsed = Number.parseInt(process.env.SHIPPING_FEE_CENTS ?? '799', 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= 100_000 ? parsed : 799;
};

app.get('/api/health', (_request, response) => response.json({ status: 'ok' }));
app.get('/api/store-config', (_request, response) => response.json({ shippingCents: getShippingFeeCents(), currency: 'usd', taxEnabled: false }));
app.get('/api/csrf', (_request, response) => {
  const token = createCsrfToken();
  response.cookie('csrf', token, { httpOnly: false, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge: 2 * 60 * 60 * 1000 });
  response.json({ token });
});

app.post('/api/auth/register', asyncRoute(async (request, response) => {
  const input = authSchema.extend({ name: z.string().trim().min(1).max(120) }).parse(request.body);
  const email = input.email.toLowerCase();
  const hash = await bcrypt.hash(input.password, 12);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ id: string; name: string; email: string; role: 'customer' }>(
      "INSERT INTO users(name,email,password_hash) VALUES($1,$2,$3) RETURNING id,name,email,role", [input.name, email, hash]);
    await client.query('INSERT INTO carts(user_id) VALUES($1)', [rows[0]!.id]);
    await client.query('COMMIT');
    setSession(response, rows[0]!);
    response.status(201).json({ user: rows[0] });
  } catch (error) { await client.query('ROLLBACK'); if ((error as { code?: string }).code === '23505') fail(409, 'An account with this email already exists.'); throw error; }
  finally { client.release(); }
}));
app.post('/api/auth/login', asyncRoute(async (request, response) => {
  const input = authSchema.omit({ name: true }).parse(request.body);
  const { rows } = await pool.query<{ id: string; name: string; email: string; role: 'customer'|'admin'; password_hash: string }>(
    'SELECT id,name,email,role,password_hash FROM users WHERE email=lower($1)', [input.email]);
  const user = rows[0];
  if (!user) return fail(401, 'Email or password is incorrect.');
  if (!await bcrypt.compare(input.password, user.password_hash)) return fail(401, 'Email or password is incorrect.');
  setSession(response, user);
  response.json({ user: { id: user.id, name: user.name, email: user.email, role: user.role } });
}));
app.post('/api/auth/logout', (_request, response) => { clearSession(response); response.json({ ok: true }); });
app.get('/api/auth/me', requireAuth, asyncRoute(async (request, response) => {
  const { rows } = await pool.query('SELECT id,name,email,role FROM users WHERE id=$1', [request.user!.id]);
  if (!rows[0]) fail(401, 'Account no longer exists.');
  response.json({ user: rows[0] });
}));

app.get('/api/categories', asyncRoute(async (_request, response) => {
  const { rows } = await pool.query('SELECT id,name,slug,description FROM categories ORDER BY name');
  response.json({ data: rows });
}));
app.get('/api/products', asyncRoute(async (request, response) => {
  const page = Math.min(100_000, Math.max(1, Number.parseInt(String(request.query.page ?? '1'), 10) || 1));
  const limit = Math.min(48, Math.max(1, Number.parseInt(String(request.query.limit ?? '12'), 10) || 12));
  const search = String(request.query.search ?? '').trim().slice(0, 120);
  const category = typeof request.query.category === 'string' ? request.query.category : '';
  const minPrice = Number(request.query.minPrice ?? 0);
  const maxPrice = request.query.maxPrice === undefined ? maxPriceCents / 100 : Number(request.query.maxPrice);
  if (!Number.isFinite(minPrice) || !Number.isFinite(maxPrice) || minPrice < 0 || maxPrice < 0 ||
      minPrice * 100 > maxPriceCents || maxPrice * 100 > maxPriceCents) {
    return fail(400, 'Price filters must be between $0 and $21,474,836.47.');
  }
  const args = [`%${search.replace(/[\\%_]/g, '\\$&')}%`, category || null, Math.floor(minPrice * 100), Math.floor(maxPrice * 100)];
  const predicate = `p.active=true AND (p.name ILIKE $1 OR p.description ILIKE $1) AND ($2::text IS NULL OR c.slug=$2) AND p.price_cents BETWEEN $3 AND $4`;
  const [items, total] = await Promise.all([
    pool.query(`SELECT ${productSelect} FROM products p JOIN categories c ON c.id=p.category_id WHERE ${predicate} ORDER BY p.featured DESC,p.created_at DESC LIMIT $5 OFFSET $6`, [...args, limit, (page - 1) * limit]),
    pool.query<{ total: string }>(`SELECT count(*) AS total FROM products p JOIN categories c ON c.id=p.category_id WHERE ${predicate}`, args),
  ]);
  const count = Number(total.rows[0]!.total);
  response.json({ data: items.rows, pagination: { page, limit, total: count, totalPages: Math.ceil(count / limit) } });
}));
app.get('/api/products/:slug', asyncRoute(async (request, response) => {
  const { rows } = await pool.query(`SELECT ${productSelect} FROM products p JOIN categories c ON c.id=p.category_id WHERE p.slug=$1 AND p.active=true`, [request.params.slug]);
  if (!rows[0]) fail(404, 'Product not found.');
  response.json({ data: rows[0] });
}));

app.get('/api/cart', requireAuth, asyncRoute(async (request, response) => {
  const { rows } = await pool.query(`SELECT ci.product_id AS "productId",p.name,p.slug,p.price_cents AS "priceCents",p.stock,ci.quantity,
    (SELECT url FROM product_images WHERE product_id=p.id ORDER BY position LIMIT 1) AS image
    FROM carts ca JOIN cart_items ci ON ci.cart_id=ca.id JOIN products p ON p.id=ci.product_id WHERE ca.user_id=$1 ORDER BY p.name`, [request.user!.id]);
  response.json({ data: rows, totalCents: rows.reduce((sum: number, item: { priceCents: number; quantity: number }) => sum + item.priceCents * item.quantity, 0) });
}));
app.post('/api/cart/items', requireAuth, asyncRoute(async (request, response) => {
  const input = z.object({ productId: uuid, quantity: z.number().int().min(1).max(99).default(1) }).parse(request.body);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const product = await client.query<{ stock: number; active: boolean }>('SELECT stock,active FROM products WHERE id=$1 FOR UPDATE', [input.productId]);
    if (!product.rows[0]?.active) fail(404, 'This product is unavailable.');
    const cart = await client.query<{ id: string }>('SELECT id FROM carts WHERE user_id=$1', [request.user!.id]);
    const cartId = cart.rows[0]?.id ?? (await client.query<{ id: string }>('INSERT INTO carts(user_id) VALUES($1) RETURNING id', [request.user!.id])).rows[0]!.id;
    const item = await client.query<{ quantity: number }>('SELECT quantity FROM cart_items WHERE cart_id=$1 AND product_id=$2', [cartId, input.productId]);
    const quantity = input.quantity + (item.rows[0]?.quantity ?? 0);
    if (quantity > product.rows[0]!.stock) fail(409, 'There is not enough stock for that quantity.');
    await client.query(`INSERT INTO cart_items(cart_id,product_id,quantity) VALUES($1,$2,$3) ON CONFLICT(cart_id,product_id) DO UPDATE SET quantity=EXCLUDED.quantity`, [cartId, input.productId, quantity]);
    await client.query('COMMIT');
    response.status(201).json({ ok: true });
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}));
app.patch('/api/cart/items/:productId', requireAuth, asyncRoute(async (request, response) => {
  const { quantity } = z.object({ quantity: z.number().int().min(1).max(99) }).parse(request.body);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ stock: number; cart_id: string }>(`SELECT p.stock,ca.id AS cart_id FROM carts ca JOIN cart_items ci ON ci.cart_id=ca.id JOIN products p ON p.id=ci.product_id WHERE ca.user_id=$1 AND p.id=$2 FOR UPDATE OF p`, [request.user!.id, request.params.productId]);
    const current = rows[0];
    if (!current) return fail(404, 'Cart item not found.');
    if (quantity > current.stock) return fail(409, 'There is not enough stock for that quantity.');
    await client.query('UPDATE cart_items SET quantity=$1 WHERE cart_id=$2 AND product_id=$3', [quantity, current.cart_id, request.params.productId]);
    await client.query('COMMIT'); response.json({ ok: true });
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}));
app.delete('/api/cart/items/:productId', requireAuth, asyncRoute(async (request, response) => {
  await pool.query('DELETE FROM cart_items ci USING carts ca WHERE ci.cart_id=ca.id AND ca.user_id=$1 AND ci.product_id=$2', [request.user!.id, request.params.productId]);
  response.json({ ok: true });
}));

const checkoutSchema = z.object({ name: z.string().trim().min(1).max(120), email: z.email().max(254), address: z.string().trim().min(5).max(500) });
app.post('/api/checkout', requireAuth, asyncRoute(async (request, response) => {
  const stripeClient = stripe;
  if (!stripeClient) return fail(503, 'Online checkout is not configured yet.');
  const customer = checkoutSchema.parse(request.body);
  const client = await pool.connect();
  let orderId: string | undefined;
  try {
    await client.query('BEGIN');
    const cart = await client.query<{ id: string }>('SELECT id FROM carts WHERE user_id=$1 FOR UPDATE', [request.user!.id]);
    const cartRow = cart.rows[0];
    if (!cartRow) return fail(400, 'Your cart is empty.');
    const { rows: items } = await client.query<{ product_id: string; name: string; price_cents: number; quantity: number; stock: number; active: boolean }>(
      `SELECT p.id AS product_id,p.name,p.price_cents,ci.quantity,p.stock,p.active FROM cart_items ci JOIN products p ON p.id=ci.product_id WHERE ci.cart_id=$1 ORDER BY p.id FOR UPDATE OF p`, [cartRow.id]);
    if (!items.length) return fail(400, 'Your cart is empty.');
    for (const item of items) { if (!item.active) return fail(409, `${item.name} is no longer available.`); if (item.quantity > item.stock) return fail(409, `${item.name} no longer has enough stock.`); }
    const subtotal = items.reduce((sum, item) => sum + item.price_cents * item.quantity, 0);
    const shipping = getShippingFeeCents();
    const total = subtotal + shipping;
    const order = await client.query<{ id: string }>(`INSERT INTO orders(user_id,subtotal_cents,shipping_cents,total_cents,shipping_name,shipping_email,shipping_address)
      VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [request.user!.id, subtotal, shipping, total, customer.name, customer.email.toLowerCase(), customer.address]);
    orderId = order.rows[0]!.id;
    await client.query('INSERT INTO payments(order_id,amount_cents) VALUES($1,$2)', [orderId, total]);
    for (const item of items) {
      await client.query('INSERT INTO order_items(order_id,product_id,product_name,unit_price_cents,quantity) VALUES($1,$2,$3,$4,$5)', [orderId,item.product_id,item.name,item.price_cents,item.quantity]);
      await client.query('UPDATE products SET stock=stock-$1,updated_at=now() WHERE id=$2', [item.quantity,item.product_id]);
    }
    await client.query('DELETE FROM cart_items WHERE cart_id=$1', [cartRow.id]);
    await client.query('COMMIT');
    const intent = await stripeClient.paymentIntents.create({ amount: total, currency: 'usd', automatic_payment_methods: { enabled: true }, metadata: { orderId, userId: request.user!.id } }, { idempotencyKey: `order-${orderId}` });
    try { await pool.query('UPDATE payments SET provider_intent_id=$1 WHERE order_id=$2', [intent.id, orderId]); }
    catch (error) { await stripeClient.paymentIntents.cancel(intent.id); throw error; }
    response.status(201).json({ orderId, clientSecret: intent.client_secret, totalCents: total, currency: intent.currency });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* The transaction may already have committed. */ }
    if (orderId) {
      const compensation = await pool.connect();
      try {
        await compensation.query('BEGIN');
        const pending = await compensation.query('SELECT 1 FROM payments WHERE order_id=$1 AND provider_intent_id IS NULL FOR UPDATE', [orderId]);
        if (pending.rowCount) {
          await compensation.query(`UPDATE orders SET status='cancelled' WHERE id=$1 AND status='pending'`, [orderId]);
          await compensation.query(`UPDATE payments SET status='failed' WHERE order_id=$1`, [orderId]);
          await compensation.query(`UPDATE products p SET stock=p.stock+oi.quantity FROM order_items oi WHERE oi.order_id=$1 AND oi.product_id=p.id`, [orderId]);
          await compensation.query(`INSERT INTO cart_items(cart_id,product_id,quantity) SELECT c.id,oi.product_id,oi.quantity FROM orders o JOIN carts c ON c.user_id=o.user_id JOIN order_items oi ON oi.order_id=o.id WHERE o.id=$1 AND oi.product_id IS NOT NULL ON CONFLICT(cart_id,product_id) DO UPDATE SET quantity=cart_items.quantity+EXCLUDED.quantity`, [orderId]);
        }
        await compensation.query('COMMIT');
      } catch (compensationError) { await compensation.query('ROLLBACK'); console.error('Checkout compensation failed:', compensationError instanceof Error ? compensationError.message : compensationError); }
      finally { compensation.release(); }
    }
    throw error;
  } finally { client.release(); }
}));

app.post('/api/payments/webhook', asyncRoute(async (request, response) => {
  const stripeClient = stripe;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!stripeClient || !webhookSecret) return fail(503, 'Payment webhooks are not configured.');
  let event: Stripe.Event;
  try { event = stripeClient.webhooks.constructEvent(request.body as Buffer, request.header('stripe-signature') ?? '', webhookSecret); }
  catch { fail(400, 'Invalid payment provider signature.'); }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query('INSERT INTO processed_webhooks(event_id) VALUES($1) ON CONFLICT DO NOTHING RETURNING event_id', [event!.id]);
    if (!inserted.rowCount) { await client.query('COMMIT'); return response.json({ received: true, duplicate: true }); }
    if (event!.type === 'payment_intent.succeeded' || event!.type === 'payment_intent.canceled' || event!.type === 'payment_intent.payment_failed') {
      const intent = event!.data.object as Stripe.PaymentIntent;
      const paid = event!.type === 'payment_intent.succeeded';
      const canceled = event!.type === 'payment_intent.canceled';
      const orderId = intent.metadata.orderId;
      if (orderId) {
        await client.query('UPDATE payments SET status=$1 WHERE provider_intent_id=$2', [paid ? 'paid' : 'failed', intent.id]);
        if (paid) await client.query("UPDATE orders SET status='paid' WHERE id=$1 AND status='pending'", [orderId]);
        else if (canceled) {
          const { rows } = await client.query<{ product_id: string; quantity: number }>('SELECT product_id,quantity FROM order_items WHERE order_id=$1 AND product_id IS NOT NULL', [orderId]);
          const canceledOrder = await client.query("UPDATE orders SET status='cancelled' WHERE id=$1 AND status='pending' RETURNING id", [orderId]);
          if (canceledOrder.rowCount) for (const item of rows) await client.query('UPDATE products SET stock=stock+$1 WHERE id=$2', [item.quantity,item.product_id]);
        }
      }
    }
    await client.query('COMMIT'); response.json({ received: true });
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}));

app.get('/api/orders', requireAuth, asyncRoute(async (request, response) => {
  const { rows } = await pool.query(`SELECT o.id,o.status,o.total_cents AS "totalCents",o.created_at AS "createdAt",
    COALESCE(json_agg(json_build_object('name',oi.product_name,'quantity',oi.quantity,'unitPriceCents',oi.unit_price_cents)) FILTER (WHERE oi.id IS NOT NULL),'[]') AS items
    FROM orders o LEFT JOIN order_items oi ON oi.order_id=o.id WHERE o.user_id=$1 GROUP BY o.id ORDER BY o.created_at DESC`, [request.user!.id]);
  response.json({ data: rows });
}));
app.get('/api/orders/:id', requireAuth, asyncRoute(async (request, response) => {
  const { rows } = await pool.query(`SELECT o.id,o.status,o.subtotal_cents AS "subtotalCents",o.shipping_cents AS "shippingCents",o.total_cents AS "totalCents",o.created_at AS "createdAt",o.shipping_name AS "shippingName",o.shipping_address AS "shippingAddress",
    COALESCE(json_agg(json_build_object('name',oi.product_name,'quantity',oi.quantity,'unitPriceCents',oi.unit_price_cents)) FILTER (WHERE oi.id IS NOT NULL),'[]') AS items
    FROM orders o LEFT JOIN order_items oi ON oi.order_id=o.id WHERE o.id=$1 AND o.user_id=$2 GROUP BY o.id`, [request.params.id,request.user!.id]);
  if (!rows[0]) fail(404, 'Order not found.'); response.json({ data: rows[0] });
}));

app.get('/api/admin/products', requireAuth, requireAdmin, asyncRoute(async (_request,response) => {
  const { rows } = await pool.query(`SELECT ${productSelect} FROM products p JOIN categories c ON c.id=p.category_id ORDER BY p.created_at DESC`);
  response.json({ data: rows });
}));
app.post('/api/admin/products', requireAuth, requireAdmin, asyncRoute(async (request,response) => {
  const input = productSchema.parse(request.body);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ id:string }>(`INSERT INTO products(name,slug,description,price_cents,stock,low_stock_threshold,category_id,active,featured) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`, [input.name,input.slug,input.description,input.priceCents,input.stock,input.lowStockThreshold,input.categoryId,input.active,input.featured]);
    if (input.imageUrl) await client.query('INSERT INTO product_images(product_id,url,alt_text) VALUES($1,$2,$3)', [rows[0]!.id,input.imageUrl,input.imageAlt]);
    await client.query('COMMIT'); response.status(201).json({ id: rows[0]!.id });
  } catch (error) { await client.query('ROLLBACK'); if ((error as { code?:string }).code==='23505') fail(409,'A product with that slug already exists.'); throw error; } finally { client.release(); }
}));
app.put('/api/admin/products/:id', requireAuth, requireAdmin, asyncRoute(async (request,response) => {
  const input = productSchema.parse(request.body);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const update = await client.query(`UPDATE products SET name=$1,slug=$2,description=$3,price_cents=$4,stock=$5,low_stock_threshold=$6,category_id=$7,active=$8,featured=$9,updated_at=now() WHERE id=$10`, [input.name,input.slug,input.description,input.priceCents,input.stock,input.lowStockThreshold,input.categoryId,input.active,input.featured,request.params.id]);
    if (!update.rowCount) fail(404,'Product not found.');
    await client.query('DELETE FROM product_images WHERE product_id=$1',[request.params.id]);
    if (input.imageUrl) await client.query('INSERT INTO product_images(product_id,url,alt_text) VALUES($1,$2,$3)', [request.params.id,input.imageUrl,input.imageAlt]);
    await client.query('COMMIT'); response.json({ ok:true });
  } catch (error) { await client.query('ROLLBACK'); if ((error as { code?:string }).code==='23505') fail(409,'A product with that slug already exists.'); throw error; } finally { client.release(); }
}));
app.delete('/api/admin/products/:id', requireAuth, requireAdmin, asyncRoute(async (request,response) => {
  const result = await pool.query('UPDATE products SET active=false,updated_at=now() WHERE id=$1',[request.params.id]);
  if (!result.rowCount) fail(404,'Product not found.'); response.json({ ok:true });
}));
app.post('/api/admin/categories', requireAuth, requireAdmin, asyncRoute(async (request,response) => {
  const input = categorySchema.parse(request.body);
  try {
    const { rows } = await pool.query('INSERT INTO categories(name,slug,description) VALUES($1,$2,$3) RETURNING id',[input.name,input.slug,input.description]);
    response.status(201).json({ id:rows[0]!.id });
  } catch (error) { if ((error as {code?:string}).code==='23505') fail(409,'A category with that name or URL already exists.'); throw error; }
}));
app.post('/api/admin/images/signature', requireAuth, requireAdmin, asyncRoute(async (_request,response) => {
  const cloudName=process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey=process.env.CLOUDINARY_API_KEY;
  const apiSecret=process.env.CLOUDINARY_API_SECRET;
  if(!cloudName||!apiKey||!apiSecret) fail(503,'Image uploads are not configured. Add the Cloudinary settings to the API environment.');
  const timestamp=Math.floor(Date.now()/1000);
  const folder='fishing-store/products';
  const publicId=randomUUID();
  const signatureParameters=`folder=${folder}&public_id=${publicId}&timestamp=${timestamp}`;
  const signature=createHash('sha1').update(`${signatureParameters}${apiSecret}`).digest('hex');
  response.json({cloudName,apiKey,timestamp,signature,folder,publicId});
}));
app.put('/api/admin/categories/:id', requireAuth, requireAdmin, asyncRoute(async (request,response) => {
  const input = categorySchema.parse(request.body);
  try {
    const result = await pool.query('UPDATE categories SET name=$1,slug=$2,description=$3 WHERE id=$4',[input.name,input.slug,input.description,request.params.id]);
    if (!result.rowCount) fail(404,'Category not found.'); response.json({ok:true});
  } catch (error) { if ((error as {code?:string}).code==='23505') fail(409,'A category with that name or URL already exists.'); throw error; }
}));
app.delete('/api/admin/categories/:id', requireAuth, requireAdmin, asyncRoute(async (request,response) => {
  const productsInCategory = await pool.query('SELECT 1 FROM products WHERE category_id=$1 LIMIT 1',[request.params.id]);
  if (productsInCategory.rowCount) fail(409,'Reassign this category’s products before deleting it.');
  const result = await pool.query('DELETE FROM categories WHERE id=$1',[request.params.id]);
  if (!result.rowCount) fail(404,'Category not found.'); response.json({ok:true});
}));
app.get('/api/admin/orders', requireAuth, requireAdmin, asyncRoute(async (_request,response) => {
  const { rows } = await pool.query(`SELECT o.id,o.status,o.total_cents AS "totalCents",o.created_at AS "createdAt",u.name,u.email FROM orders o JOIN users u ON u.id=o.user_id ORDER BY o.created_at DESC LIMIT 200`);
  response.json({ data:rows });
}));
app.patch('/api/admin/orders/:id/status', requireAuth, requireAdmin, asyncRoute(async (request,response) => {
  const { status } = z.object({status:z.enum(['processing','shipped','delivered'])}).parse(request.body);
  const result = await pool.query(`UPDATE orders SET status=$1 WHERE id=$2 AND
    ((status='paid' AND $1='processing') OR (status='processing' AND $1='shipped') OR (status='shipped' AND $1='delivered')) RETURNING id`,[status,request.params.id]);
  if (!result.rowCount) {
    const exists = await pool.query('SELECT id FROM orders WHERE id=$1',[request.params.id]);
    if (!exists.rowCount) fail(404,'Order not found.');
    fail(409,'That order cannot move to the selected status.');
  }
  response.json({ok:true});
}));
app.post('/api/admin/orders/:id/cancel', requireAuth, requireAdmin, asyncRoute(async (request,response) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const order = await client.query<{status:string;provider_intent_id:string|null}>(`SELECT o.status,p.provider_intent_id FROM orders o JOIN payments p ON p.order_id=o.id WHERE o.id=$1 FOR UPDATE OF o,p`,[request.params.id]);
    const current=order.rows[0];
    if(!current) return fail(404,'Order not found.');
    if(current.status!=='pending') return fail(409,'Only unpaid pending orders can be cancelled.');
    if(current.provider_intent_id&&stripe) await stripe.paymentIntents.cancel(current.provider_intent_id);
    await client.query("UPDATE orders SET status='cancelled' WHERE id=$1",[request.params.id]);
    await client.query("UPDATE payments SET status='failed' WHERE order_id=$1",[request.params.id]);
    await client.query('UPDATE products p SET stock=p.stock+oi.quantity FROM order_items oi WHERE oi.order_id=$1 AND oi.product_id=p.id',[request.params.id]);
    await client.query(`INSERT INTO cart_items(cart_id,product_id,quantity) SELECT c.id,oi.product_id,oi.quantity FROM orders o JOIN carts c ON c.user_id=o.user_id JOIN order_items oi ON oi.order_id=o.id WHERE o.id=$1 AND oi.product_id IS NOT NULL ON CONFLICT(cart_id,product_id) DO UPDATE SET quantity=cart_items.quantity+EXCLUDED.quantity`,[request.params.id]);
    await client.query('COMMIT');response.json({ok:true});
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}));
app.get('/api/admin/customers', requireAuth, requireAdmin, asyncRoute(async (_request,response) => {
  const { rows } = await pool.query(`SELECT u.id,u.name,u.email,u.created_at AS "createdAt",count(o.id)::int AS "orderCount" FROM users u LEFT JOIN orders o ON o.user_id=u.id WHERE u.role='customer' GROUP BY u.id ORDER BY u.created_at DESC LIMIT 200`);
  response.json({data:rows});
}));

app.use('/api', (_request,response) => response.status(404).json({error:'API route not found.'}));
app.use(errorHandler);
export default app;
