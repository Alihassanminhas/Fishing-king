import 'dotenv/config';
import { pool } from './pool.js';

const categories = [
  ['Rods', 'rods', 'Balanced rods for rivers, lakes, and shorelines.'],
  ['Reels', 'reels', 'Smooth, dependable reels for every cast.'],
  ['Lures', 'lures', 'Proven colors and profiles for hungry fish.'],
  ['Tackle', 'tackle', 'Keep your essentials organized and ready.'],
];
const products = [
  ['Coastal Spinning Rod 7ft', 'coastal-spinning-rod-7ft', 'A responsive medium-action rod built for long, accurate casts.', 7499, 18, 'rods', true, 'https://images.unsplash.com/photo-1534787238916-9ba6764efd4f?auto=format&fit=crop&w=1000&q=85'],
  ['Tidewater 3000 Reel', 'tidewater-3000-reel', 'Smooth drag and a sealed body for dependable inshore days.', 6299, 12, 'reels', true, 'https://images.unsplash.com/photo-1511497584788-876760111969?auto=format&fit=crop&w=1000&q=85'],
  ['Silver Minnow Lure Set', 'silver-minnow-lure-set', 'A three-piece set with lifelike action for clear water.', 1899, 40, 'lures', true, 'https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?auto=format&fit=crop&w=1000&q=85'],
  ['Trailhead Tackle Box', 'trailhead-tackle-box', 'Adjustable compartments keep hooks, weights, and lures close.', 3299, 24, 'tackle', true, 'https://images.unsplash.com/photo-1473116763249-2faaef81ccda?auto=format&fit=crop&w=1000&q=85'],
  ['Riverglass Ultralight Rod', 'riverglass-ultralight-rod', 'Lightweight graphite blank with a comfortable cork grip.', 5899, 9, 'rods', false, 'https://images.unsplash.com/photo-1498654200943-1088dd4438ae?auto=format&fit=crop&w=1000&q=85'],
  ['Reef Runner Crankbait Pack', 'reef-runner-crankbait-pack', 'Three diving profiles for covering water from bank to boat.', 2499, 31, 'lures', false, 'https://images.unsplash.com/photo-1501785888041-af3ef285b470?auto=format&fit=crop&w=1000&q=85'],
];
try {
  for (const [name, slug, description] of categories) {
    await pool.query('INSERT INTO categories(name,slug,description) VALUES($1,$2,$3) ON CONFLICT(slug) DO UPDATE SET name=EXCLUDED.name, description=EXCLUDED.description', [name, slug, description]);
  }
  for (const [name, slug, description, price, stock, category, featured, image] of products) {
    const result = await pool.query<{ id: string }>(
      `INSERT INTO products(name,slug,description,price_cents,stock,category_id,featured)
       SELECT $1,$2,$3,$4,$5,id,$7 FROM categories WHERE slug=$6
       ON CONFLICT(slug) DO UPDATE SET name=EXCLUDED.name, description=EXCLUDED.description,
         price_cents=EXCLUDED.price_cents, stock=EXCLUDED.stock, category_id=EXCLUDED.category_id, featured=EXCLUDED.featured
       RETURNING id`, [name, slug, description, price, stock, category, featured]);
    await pool.query('DELETE FROM product_images WHERE product_id=$1', [result.rows[0]!.id]);
    await pool.query('INSERT INTO product_images(product_id,url,alt_text) VALUES($1,$2,$3)', [result.rows[0]!.id, image, name]);
  }
  console.log('Seed data inserted.');
} catch (error) {
  console.error('Seed failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally { await pool.end(); }
