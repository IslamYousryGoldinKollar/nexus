import type { Config } from 'drizzle-kit';

const connectionString =
  process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL ?? '';

if (!connectionString) {
  // Drizzle-kit will error out later; we surface a clearer message here.
  // eslint-disable-next-line no-console
  console.warn(
    '[drizzle.config] Neither DATABASE_URL_UNPOOLED nor DATABASE_URL is set. ' +
      'Migrations will fail until one is provided.',
  );
}

export default {
  schema: './src/schema/index.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: connectionString,
  },
  verbose: true,
  strict: true,
  casing: 'snake_case',
} satisfies Config;
