import { FieldValue } from 'firebase-admin/firestore'
import { HttpError } from './errors.js'

export const categories = ['All resources', 'Free images', 'PSD templates', 'Posters', 'Flyers', 'African designs']
const categoryTypes = { 'Free images': 'Image', 'PSD templates': 'PSD', Posters: 'Poster', Flyers: 'Flyer' }
const record = (doc) => ({ ...doc.data(), id: doc.id })
export function publicResource(data) {
  const { filePath, previewPath, ...resource } = data
  return resource
}

export function createRepository(db) {
  const resources = db.collection('resources')
  const users = db.collection('users')
  async function getResource(id) {
    const doc = await resources.doc(id).get()
    if (!doc.exists) throw new HttpError(404, 'Resource not found')
    return record(doc)
  }
  return {
    getResource,
    async list({ q = '', category = 'All resources', cursor, limit = 24 }) {
      let query = resources.orderBy('__name__')
      if (categoryTypes[category]) query = query.where('type', '==', categoryTypes[category])
      if (category === 'African designs') query = query.where('category', '==', 'African Designs')
      if (cursor) query = query.startAfter(cursor)
      // Bounded scanning supports substring search without a separate search service.
      // Clients follow nextCursor even when a search page contains fewer than limit hits.
      const snapshot = await query.limit(200).get()
      const items = []
      let last = null
      let scanned = 0
      for (const doc of snapshot.docs) {
        scanned++
        last = doc.id
        const item = record(doc)
        if (`${item.title} ${item.type} ${item.creator} ${item.category} ${item.description}`.toLowerCase().includes(q.toLowerCase())) items.push(publicResource(item))
        if (items.length === limit) break
      }
      return { items, nextCursor: scanned < snapshot.size || snapshot.size === 200 ? last : null }
    },
    async profile(identity) {
      const ref = users.doc(identity.uid)
      const value = { uid: identity.uid, displayName: identity.name || 'Setla creator', email: identity.email || '', photoURL: identity.picture || '', updatedAt: new Date().toISOString() }
      await ref.set(value, { merge: true })
      return value
    },
    async activity(uid) {
      const [likes, saves] = await Promise.all(['likes', 'saves'].map((name) => users.doc(uid).collection(name).get()))
      return { liked: likes.docs.map((doc) => doc.id), saved: saves.docs.map((doc) => doc.id) }
    },
    async saved(uid, { cursor, limit = 24 }) {
      let query = users.doc(uid).collection('saves').orderBy('__name__')
      if (cursor) query = query.startAfter(cursor)
      const snapshot = await query.limit(limit + 1).get()
      const page = snapshot.docs.slice(0, limit)
      const docs = page.length ? await db.getAll(...page.map((doc) => resources.doc(doc.id))) : []
      return { items: docs.filter((doc) => doc.exists).map((doc) => publicResource(record(doc))), nextCursor: snapshot.size > limit ? page.at(-1).id : null }
    },
    async mine(uid, { cursor, limit = 24 }) {
      let query = resources.where('ownerId', '==', uid).orderBy('__name__')
      if (cursor) query = query.startAfter(cursor)
      const snapshot = await query.limit(limit + 1).get()
      return { items: snapshot.docs.slice(0, limit).map((doc) => publicResource(record(doc))), nextCursor: snapshot.size > limit ? snapshot.docs[limit - 1].id : null }
    },
    async create(id, value) { await resources.doc(id).create(value); return publicResource({ id, ...value }) },
    async reaction(uid, id, kind, enabled) {
      const resourceRef = resources.doc(id)
      const ref = users.doc(uid).collection(kind).doc(id)
      return db.runTransaction(async (tx) => {
        const [resource, reaction] = await Promise.all([tx.get(resourceRef), tx.get(ref)])
        if (!resource.exists) throw new HttpError(404, 'Resource not found')
        const delta = Number(enabled) - Number(reaction.exists)
        if (enabled) tx.set(ref, { createdAt: new Date().toISOString() })
        else tx.delete(ref)
        const likes = Math.max(0, (resource.data().likes || 0) + (kind === 'likes' ? delta : 0))
        if (kind === 'likes' && delta) tx.update(resourceRef, { likes })
        return { enabled, likes }
      })
    },
    async download(id) { await resources.doc(id).update({ downloads: FieldValue.increment(1) }) },
    async update(uid, id, changes) {
      return db.runTransaction(async (tx) => {
        const ref = resources.doc(id)
        const doc = await tx.get(ref)
        if (!doc.exists) throw new HttpError(404, 'Resource not found')
        if (doc.data().ownerId !== uid) throw new HttpError(403, 'Only the creator can edit this resource')
        tx.update(ref, changes)
        return publicResource({ ...record(doc), ...changes })
      })
    },
    async remove(uid, id) {
      return db.runTransaction(async (tx) => {
        const ref = resources.doc(id)
        const doc = await tx.get(ref)
        if (!doc.exists) throw new HttpError(404, 'Resource not found')
        if (doc.data().ownerId !== uid) throw new HttpError(403, 'Only the creator can delete this resource')
        tx.delete(ref)
        return record(doc)
      })
    },
  }
}
