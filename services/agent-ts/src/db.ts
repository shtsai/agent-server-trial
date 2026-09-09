import pg from "pg";

// A rejection caches as readily as a connection, so never memoize the promise itself without
// evicting on failure -- one transient error would otherwise be served to every later caller.
let pool: pg.Pool | undefined;

export function db(): pg.Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is not set");
    pool = new pg.Pool({ connectionString, max: 5 });
  }
  return pool;
}
