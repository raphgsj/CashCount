import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  breakpoints: true,
  dialect: 'postgresql',
  out: './drizzle',
  schema: './src/schema.ts',
  strict: true,
});
