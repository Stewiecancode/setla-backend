import { createClient } from '@supabase/supabase-js'

export function createSupabase(env = process.env) {
  for (const key of ['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'SUPABASE_STORAGE_BUCKET', 'FRONTEND_ORIGINS']) {
    if (!env[key]?.trim()) throw new Error(`Missing ${key}. Configure Supabase using .env.example.`)
  }
  return createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })
}

// getUser validates the supplied access token with Supabase Auth on every request.
export function createAuth(client) {
  return {
    async verifyToken(token) {
      const { data, error } = await client.auth.getUser(token)
      if (error || !data.user) throw error || new Error('Invalid session')
      const user = data.user
      return {
        uid: user.id, email: user.email,
        name: user.user_metadata?.full_name || user.user_metadata?.name,
        picture: user.user_metadata?.avatar_url,
        email_verified: Boolean(user.email_confirmed_at),
        // Provider is server-managed metadata, never editable user_metadata.
        provider: user.app_metadata?.provider,
      }
    },
  }
}

export function createStorage(client, bucketName) {
  const bucket = client.storage.from(bucketName)
  return {
    async upload(path, buffer, contentType) {
      const { error } = await bucket.upload(path, buffer, { contentType, upsert: false, cacheControl: '3600' })
      if (error) throw error
    },
    async preview(path) {
      const { data, error } = await bucket.download(path)
      if (error) throw error
      return { buffer: Buffer.from(await data.arrayBuffer()), contentType: data.type || 'image/jpeg' }
    },
    async remove(paths) {
      const { error } = await bucket.remove(paths)
      if (error) throw error
    },
    async signedDownload(path, filename) {
      const { data, error } = await bucket.createSignedUrl(path, 300, { download: filename })
      if (error) throw error
      return data.signedUrl
    },
  }
}
