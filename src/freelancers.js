import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { rateLimit } from 'express-rate-limit'
import { HttpError } from './errors.js'

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
const record = (doc) => ({ ...doc.data(), id: doc.id })

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

export function createFreelancerRepository(db) {
  const profiles = db.collection('freelancers')
  const threads = db.collection('conversations')
  async function page(query, { cursor, limit = 24 }) {
    query = query.orderBy('__name__')
    if (cursor) query = query.startAfter(cursor)
    const snapshot = await query.limit(limit + 1).get()
    return { items: snapshot.docs.slice(0, limit).map(record), nextCursor: snapshot.size > limit ? snapshot.docs[limit - 1].id : null }
  }
  async function member(uid, id) {
    const doc = await threads.doc(id).get()
    if (!doc.exists) throw new HttpError(404, 'Conversation not found')
    if (!doc.data().members.includes(uid)) throw new HttpError(403, 'This conversation is private')
    return doc
  }
  return {
    async freelancers(paging) { return page(profiles.where('published', '==', true), paging) },
    async freelancer(id) {
      const doc = await profiles.doc(id).get()
      if (!doc.exists || !doc.data().published) throw new HttpError(404, 'Photographer not found')
      return record(doc)
    },
    async ownFreelancer(uid) {
      const doc = await profiles.doc(uid).get()
      return doc.exists ? record(doc) : null
    },
    async saveFreelancer(uid, data) {
      const value = { ...data, updatedAt: new Date().toISOString() }
      await profiles.doc(uid).set(value)
      return { ...value, id: uid }
    },
    async conversations(uid, paging) { return page(threads.where('members', 'array-contains', uid), paging) },
    async contact(identity, photographerId, text) {
      if (identity.uid === photographerId) throw new HttpError(400, 'You cannot contact yourself')
      // A stable ID keeps repeat enquiries in the same thread.
      const id = createHash('sha256').update(JSON.stringify([photographerId, identity.uid])).digest('hex')
      const ref = threads.doc(id)
      const messageId = randomUUID()
      return db.runTransaction(async (tx) => {
        const [profile, existing] = await Promise.all([tx.get(profiles.doc(photographerId)), tx.get(ref)])
        if (!profile.exists || !profile.data().published) throw new HttpError(404, 'Photographer not found')
        if (!profile.data().available) throw new HttpError(409, 'This photographer is not accepting new enquiries')
        const now = new Date().toISOString()
        const value = existing.exists ? existing.data() : {
          members: [photographerId, identity.uid], photographerId,
          names: { [photographerId]: profile.data().displayName, [identity.uid]: identity.name || 'Setla member' }, createdAt: now,
        }
        const thread = { ...value, lastMessage: text, updatedAt: now }
        tx.set(ref, thread)
        tx.set(ref.collection('messages').doc(messageId), { senderId: identity.uid, text, createdAt: now })
        return { ...thread, id }
      })
    },
    async messages(uid, id, { cursor, limit = 24 }) {
      await member(uid, id)
      const collection = threads.doc(id).collection('messages')
      let query = collection.orderBy('createdAt', 'desc').orderBy('__name__', 'desc')
      if (cursor) {
        const last = await collection.doc(cursor).get()
        if (!last.exists) throw new HttpError(400, 'Invalid message cursor')
        query = query.startAfter(last)
      }
      const snapshot = await query.limit(limit + 1).get()
      return { items: snapshot.docs.slice(0, limit).map(record), nextCursor: snapshot.size > limit ? snapshot.docs[limit - 1].id : null }
    },
    async sendMessage(uid, id, text) {
      const ref = threads.doc(id)
      const messageId = randomUUID()
      return db.runTransaction(async (tx) => {
        const thread = await tx.get(ref)
        if (!thread.exists) throw new HttpError(404, 'Conversation not found')
        if (!thread.data().members.includes(uid)) throw new HttpError(403, 'This conversation is private')
        const message = { senderId: uid, text, createdAt: new Date().toISOString() }
        tx.set(ref.collection('messages').doc(messageId), message)
        tx.update(ref, { lastMessage: text, updatedAt: message.createdAt })
        return { ...message, id: messageId }
      })
    },
  }
}
