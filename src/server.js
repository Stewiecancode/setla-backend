import 'dotenv/config'
import { createApp } from './app.js'
import { createRepository } from './repository.js'
import { createSupabase, createAuth, createStorage } from './supabase.js'

const supabase = createSupabase()
const app = createApp({ repository: createRepository(supabase), auth: createAuth(supabase), storage: createStorage(supabase, process.env.SUPABASE_STORAGE_BUCKET), origins: process.env.FRONTEND_ORIGINS.split(',').map((origin) => origin.trim()), trustProxy: Number(process.env.TRUST_PROXY || 0) })
const server = app.listen(Number(process.env.PORT || 4000), () => console.log(`Setla API listening on port ${process.env.PORT || 4000}`))
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(1), 10000).unref() })
