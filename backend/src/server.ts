import 'dotenv/config';
import app from './app.js';

const port = Number(process.env.PORT ?? 4000);
const server = app.listen(port, () => console.log(`Fishing store API listening on port ${port}`));
for (const signal of ['SIGTERM','SIGINT'] as const) process.on(signal, () => server.close(() => process.exit(0)));
