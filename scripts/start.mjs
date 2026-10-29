// Runs the Nitro production build.
//
// Nitro reads its listen address from the environment at runtime, so binding to
// loopback has to happen here rather than in vite.config.ts. Defaulting instead
// of overriding keeps `HOST=0.0.0.0 pnpm start` possible for anyone who
// deliberately wants it — but never by accident.
// The port matches vite.config.ts so `pnpm start` answers where dev does. The
// always-on install uses its own port and data; see scripts/deploy-local.ps1.
process.env.HOST ??= '127.0.0.1'
process.env.PORT ??= '7331'

await import('../.output/server/index.mjs')
