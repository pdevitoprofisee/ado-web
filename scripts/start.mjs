// Runs the Nitro production build.
//
// Nitro reads its listen address from the environment at runtime, so binding to
// loopback has to happen here rather than in vite.config.ts. Defaulting instead
// of overriding keeps `HOST=0.0.0.0 pnpm start` possible for anyone who
// deliberately wants it — but never by accident.
process.env.HOST ??= '127.0.0.1'
process.env.PORT ??= '3000'

await import('../.output/server/index.mjs')
