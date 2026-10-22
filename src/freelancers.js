import { z } from 'zod'
import { rateLimit } from 'express-rate-limit'

const url = z.union([z.literal(''), z.string().trim().max(500).url().refine((value) => /^https?:\/\//i.test(value), 'Use an http or https URL')])
const profileSchema = z.object({
  displayName: z.string().trim().min(2).max(80),
  headline: z.string().trim().min(3).max(120),
  location: z.string().trim().max(120),
  bio: z.string().trim().min(20).max(2000),
  specialty: z.enum(['Portraits', 'Weddings', 'Events', 'Products', 'Fashion', 'Architecture', 'Other']),
  available: z.boolean(),
  published: z.boolean(),
  instagram: url, facebook: url, tiktok: url, website: url,
}).strict()
const messageSchema = z.object({ text: z.string().trim().min(1).max(3000) }).strict()

export function freelancerRoutes(app, repository, requireAuth, pageSchema) {
  app.get('/api/freelancers', async (req, res) => res.json(await repository.freelancers(pageSchema.parse(req.query))))
  app.get('/api/freelancers/:id', async (req, res) => res.json(await repository.freelancer(req.params.id)))
  app.get('/api/me/freelancer', async (req, res) => res.json(await repository.ownFreelancer(req.identity.uid)))
  app.put('/api/me/freelancer', async (req, res) => res.json(await repository.saveFreelancer(req.identity.uid, profileSchema.parse(req.body))))
  app.get('/api/me/conversations', async (req, res) => res.json(await repository.conversations(req.identity.uid, pageSchema.parse(req.query))))
  const messageLimit = rateLimit({ windowMs: 60000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false })
  app.post('/api/freelancers/:id/contact', requireAuth, messageLimit, async (req, res) => {
    res.status(201).json(await repository.contact(req.identity, req.params.id, messageSchema.parse(req.body).text))
  })
  app.get('/api/me/conversations/:id/messages', async (req, res) => res.json(await repository.messages(req.identity.uid, req.params.id, pageSchema.parse(req.query))))
  app.post('/api/me/conversations/:id/messages', messageLimit, async (req, res) => {
    res.status(201).json(await repository.sendMessage(req.identity.uid, req.params.id, messageSchema.parse(req.body).text))
  })
}
