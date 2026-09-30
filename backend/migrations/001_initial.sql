CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'customer' CHECK (role IN ('customer','admin')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT NOT NULL UNIQUE, slug TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), category_id UUID NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
  name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, description TEXT NOT NULL DEFAULT '', price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  stock INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0), low_stock_threshold INTEGER NOT NULL DEFAULT 5 CHECK (low_stock_threshold >= 0),
  active BOOLEAN NOT NULL DEFAULT true, featured BOOLEAN NOT NULL DEFAULT false, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS product_images (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  url TEXT NOT NULL, alt_text TEXT NOT NULL DEFAULT '', position INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS carts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS cart_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), cart_id UUID NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE, quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 99),
  UNIQUE(cart_id, product_id)
);
CREATE TABLE IF NOT EXISTS orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL REFERENCES users(id), status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','processing','shipped','delivered','cancelled','refunded')),
  subtotal_cents INTEGER NOT NULL CHECK (subtotal_cents >= 0), shipping_cents INTEGER NOT NULL CHECK (shipping_cents >= 0), total_cents INTEGER NOT NULL CHECK (total_cents >= 0),
  shipping_name TEXT NOT NULL, shipping_email TEXT NOT NULL, shipping_address TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS order_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id UUID REFERENCES products(id) ON DELETE SET NULL, product_name TEXT NOT NULL, unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0), quantity INTEGER NOT NULL CHECK (quantity > 0)
);
CREATE TABLE IF NOT EXISTS payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), order_id UUID NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
  provider_intent_id TEXT UNIQUE, status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','failed','refunded')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0), created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS processed_webhooks (event_id TEXT PRIMARY KEY, processed_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS products_category_active_idx ON products(category_id, active);
CREATE INDEX IF NOT EXISTS products_name_search_idx ON products USING gin (to_tsvector('english', name || ' ' || description));
CREATE INDEX IF NOT EXISTS order_user_created_idx ON orders(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS order_items_order_idx ON order_items(order_id);
CREATE INDEX IF NOT EXISTS cart_items_cart_idx ON cart_items(cart_id);
