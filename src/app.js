import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import { rateLimit } from 'express-rate-limit'
import multer from 'multer'
import { z, ZodError } from 'zod'
import { randomUUID } from 'node:crypto'
import { HttpError } from './errors.js'
import { categories, publicResource } from './repository.js'
import { freelancerRoutes } from './freelancers.js'

const idSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/)
const metadata = z.object({
  title: z.string().trim().min(3).max(120),
  description: z.string().trim().max(2000).default(''),
  type: z.enum(['PSD', 'Image', 'Poster', 'Flyer']),
  category: z.enum(['Photography', 'Events', 'Business', 'People', 'Architecture', 'Education', 'Social Media', 'African Designs', 'Other']),
}).strict()
const pageSchema = z.object({ cursor: idSchema.optional(), limit: z.coerce.number().int().min(1).max(48).default(24) })
const listSchema = pageSchema.extend({ q: z.string().trim().max(200).default(''), category: z.enum(categories).default('All resources') })
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 2, fields: 4, fieldSize: 8192 } })
function detectedType(buffer) {
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
  if (buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return 'image/jpeg'
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  if (buffer.toString('ascii', 0, 4) === '8BPS' && buffer.readUInt16BE(4) === 1) return 'image/vnd.adobe.photoshop'
  return null
}

export function createApp({ repository, auth, bucket, origins = ['http://localhost:3000'], trustProxy = 0, logger = console }) {
  const app = express()
  app.disable('x-powered-by')
  app.set('trust proxy', trustProxy)
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }))
  app.use(cors({ origin(origin, callback) { callback(origin && !origins.includes(origin) ? new HttpError(403, 'Origin not allowed') : null, true) } }))
  app.use(rateLimit({ windowMs: 60000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false }))
  app.use(express.json({ limit: '16kb' }))
  const requireAuth = async (req, res, next) => {
    const token = req.get('Authorization')?.match(/^Bearer (\S+)$/)?.[1]
    if (!token) throw new HttpError(401, 'Sign in with Google to continue')
    try { req.identity = await auth.verifyIdToken(token, true) }
    catch { throw new HttpError(401, 'Your session expired. Sign in again.') }
    if (req.identity.firebase?.sign_in_provider !== 'google.com' || !req.identity.email_verified) throw new HttpError(403, 'A verified Google account is required')
    next()
  }
  app.param('id', (req, res, next, value) => { idSchema.parse(value); next() })
  app.get('/health', (req, res) => res.json({ status: 'ok' }))
  app.get('/api/categories', (req, res) => res.json({ categories }))
  app.get('/api/resources', async (req, res) => res.json(await repository.list(listSchema.parse(req.query))))
  app.get('/api/resources/:id', async (req, res) => res.json(publicResource(await repository.getResource(req.params.id))))
  app.get('/api/resources/:id/preview', async (req, res) => {
    const resource = await repository.getResource(req.params.id)
    const file = bucket.file(resource.previewPath)
    const [metadata] = await file.getMetadata()
    res.set('Content-Type', metadata.contentType || 'image/jpeg')
    res.set('Cache-Control', 'public, max-age=3600')
    const stream = file.createReadStream()
    stream.on('error', (error) => { logger.error('Preview stream failed', error.message); res.destroy() })
    stream.pipe(res)
  })
  app.use('/api/me', requireAuth)
  freelancerRoutes(app, repository, requireAuth, pageSchema)
  app.get('/api/me', async (req, res) => res.json(await repository.profile(req.identity)))
  app.get('/api/me/activity', async (req, res) => res.json(await repository.activity(req.identity.uid)))
  app.get('/api/me/saved', async (req, res) => res.json(await repository.saved(req.identity.uid, pageSchema.parse(req.query))))
  app.get('/api/me/resources', async (req, res) => res.json(await repository.mine(req.identity.uid, pageSchema.parse(req.query))))
  app.post('/api/resources', requireAuth,
    rateLimit({ windowMs: 3600000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false }),
    upload.fields([{ name: 'file', maxCount: 1 }, { name: 'preview', maxCount: 1 }]),
    async (req, res) => {
      const data = metadata.parse(req.body)
      const file = req.files?.file?.[0]
      if (!file) throw new HttpError(400, 'Choose a resource file')
      const mime = file.buffer.length >= 12 ? detectedType(file.buffer) : null
      const isPsd = mime === 'image/vnd.adobe.photoshop'
      if (!mime || (data.type === 'PSD' ? !isPsd : isPsd)) throw new HttpError(400, 'PSD resources require a PSD file; other resources require PNG, JPEG or WebP')
      const preview = req.files?.preview?.[0] || (!isPsd ? file : null)
      const previewMime = preview?.buffer.length >= 12 ? detectedType(preview.buffer) : null
      if (!preview || !previewMime?.startsWith('image/') || previewMime === 'image/vnd.adobe.photoshop' || preview.size > 5 * 1024 * 1024) throw new HttpError(400, 'Provide a PNG, JPEG or WebP preview smaller than 5 MB')
      const id = randomUUID()
      const filePath = `resources/${req.identity.uid}/${id}/original`
      const previewPath = `resources/${req.identity.uid}/${id}/preview`
      try {
        await bucket.file(filePath).save(file.buffer, { resumable: false, metadata: { contentType: mime, contentDisposition: 'attachment' } })
        await bucket.file(previewPath).save(preview.buffer, { resumable: false, metadata: { contentType: previewMime } })
        const result = await repository.create(id, { ...data, ownerId: req.identity.uid, creator: req.identity.name || 'Setla creator', image: `/api/resources/${id}/preview`, height: 'aspect-[4/5]', accent: 'stone', likes: 0, downloads: 0, filePath, previewPath, fileName: file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 150), fileSize: file.size, createdAt: new Date().toISOString() })
        res.status(201).json(result)
      } catch (error) {
        await Promise.allSettled([filePath, previewPath].map((path) => bucket.file(path).delete({ ignoreNotFound: true })))
        throw error
      }
    })
  for (const kind of ['likes', 'saves']) {
    app.put(`/api/resources/:id/${kind}`, requireAuth, async (req, res) => {
      const { enabled } = z.object({ enabled: z.boolean() }).strict().parse(req.body)
      res.json(await repository.reaction(req.identity.uid, req.params.id, kind, enabled))
    })
  }
  app.post('/api/resources/:id/download', requireAuth, async (req, res) => {
    const resource = await repository.getResource(req.params.id)
    const [url] = await bucket.file(resource.filePath).getSignedUrl({ version: 'v4', action: 'read', expires: Date.now() + 5 * 60000, responseDisposition: `attachment; filename="${resource.fileName}"` })
    await repository.download(req.params.id)
    res.json({ url, expiresIn: 300 })
  })
  app.patch('/api/resources/:id', requireAuth, async (req, res) => {
    const changes = metadata.omit({ type: true }).partial().parse(req.body)
    if (!Object.keys(changes).length) throw new HttpError(400, 'Provide at least one field to update')
    res.json(await repository.update(req.identity.uid, req.params.id, { ...changes, updatedAt: new Date().toISOString() }))
  })
  app.delete('/api/resources/:id', requireAuth, async (req, res) => {
    const resource = await repository.remove(req.identity.uid, req.params.id)
    const cleanup = await Promise.allSettled([resource.filePath, resource.previewPath].map((path) => bucket.file(path).delete({ ignoreNotFound: true })))
    if (cleanup.some((result) => result.status === 'rejected')) logger.error('Storage cleanup required for deleted resource', req.params.id)
    res.status(204).end()
  })
  app.use((req, res) => res.status(404).json({ error: 'Endpoint not found' }))
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error)
    if (error instanceof ZodError) return res.status(400).json({ error: 'Invalid request', details: error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message })) })
    if (error instanceof multer.MulterError) return res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: error.message })
    const status = error.status >= 400 && error.status < 600 ? error.status : 500
    if (status >= 500) logger.error('Request failed', error)
    res.status(status).json({ error: status >= 500 ? 'The server could not complete your request' : error.message })
  })
  return app
}
