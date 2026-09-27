import test from 'node:test'
import assert from 'node:assert/strict'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { createRepository } from '../src/repository.js'

const identity = { uid: 'alice', name: 'Alice', email_verified: true, firebase: { sign_in_provider: 'google.com' } }
const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000b49444154789c636000020000050001a5f645400000000049454e44ae426082', 'hex')
function fixture(overrides = {}) {
  const files = new Map()
  const docs = new Map([['resources/existing', { title: 'Existing', type: 'Image', ownerId: 'alice', likes: 0, filePath: 'original', previewPath: 'preview', fileName: 'image.png' }]])
  function snapshot(path) { return { exists: docs.has(path), id: path.split('/').at(-1), data: () => docs.get(path) } }
  function ref(path) {
    return { path, collection: (name) => collection(`${path}/${name}`), get: async () => snapshot(path), set: async (value) => docs.set(path, value), create: async (value) => docs.set(path, value) }
  }
  function collection(path, filters = [], orders = [], cursor = null, size = Infinity) {
    return {
      doc: (id) => ref(`${path}/${id}`),
      where: (field, operator, value) => collection(path, [...filters, [field, operator, value]], orders, cursor, size),
      orderBy: (field, direction = 'asc') => collection(path, filters, [...orders, [field, direction]], cursor, size),
      startAfter: (value) => collection(path, filters, orders, value, size),
      limit: (value) => collection(path, filters, orders, cursor, value),
      get: async () => {
        const value = (doc, field) => field === '__name__' ? doc.id : doc.data()[field]
        const compare = (a, b) => { for (const [field, direction] of orders) { const result = String(value(a, field)).localeCompare(String(value(b, field))); if (result) return direction === 'desc' ? -result : result } return 0 }
        let page = [...docs.keys()].filter((key) => key.startsWith(`${path}/`) && key.split('/').length === path.split('/').length + 1).map(snapshot)
        page = page.filter((doc) => filters.every(([field, operator, expected]) => operator === 'array-contains' ? doc.data()[field].includes(expected) : doc.data()[field] === expected)).sort(compare)
        if (cursor) page = page.filter((doc) => typeof cursor === 'string' ? doc.id > cursor : compare(doc, cursor) > 0)
        page = page.slice(0, size)
        return { docs: page, size: page.length }
      },
    }
  }
  const db = {
    collection,
    runTransaction: async (fn) => fn({
      get: async (r) => ({ exists: docs.has(r.path), id: r.path.split('/').at(-1), data: () => docs.get(r.path) }),
      set: (r, value) => docs.set(r.path, value),
      update: (r, value) => docs.set(r.path, { ...docs.get(r.path), ...value }),
      delete: (r) => docs.delete(r.path),
    }),
  }
  const repository = { ...createRepository(db), list: async () => ({ items: [], nextCursor: null }), ...overrides }
  const auth = { verifyIdToken: async (token, revoked) => { assert.equal(revoked, true); if (token === 'bad') throw Error('invalid'); return token === 'password' ? { ...identity, firebase: { sign_in_provider: 'password' } } : token === 'bob' ? { ...identity, uid: 'bob' } : identity } }
  const bucket = { file: (path) => ({ save: async (buffer) => files.set(path, buffer), delete: async () => files.delete(path), getSignedUrl: async () => ['https://storage.example.test/signed'] }) }
  return { app: createApp({ repository, auth, bucket, logger: { error() {} } }), files, docs }
}
const authorized = (req, token = 'valid') => req.set('Authorization', `Bearer ${token}`)

const photographer = { displayName: 'Alice Photos', headline: 'Portrait photographer', location: 'Johannesburg', bio: 'Natural portraits for people and their stories.', specialty: 'Portraits', available: true, published: true, instagram: 'https://instagram.com/alice', facebook: '', tiktok: '', website: '' }

test('directory, inbox and message pagination filter correctly without leaking private records', async () => {
  const { app, docs } = fixture()
  docs.set('freelancers/alice', photographer)
  docs.set('freelancers/bob', { ...photographer, published: false })
  docs.set('freelancers/carol', photographer)
  const directory = await request(app).get('/api/freelancers?limit=1').expect(200)
  assert.deepEqual(directory.body.items.map((item) => item.id), ['alice'])
  assert.equal(directory.body.nextCursor, 'alice')
  const next = await request(app).get('/api/freelancers?limit=1&cursor=alice').expect(200)
  assert.deepEqual(next.body.items.map((item) => item.id), ['carol'])
  assert.equal(next.body.nextCursor, null)
  docs.set('conversations/ours', { members: ['alice', 'bob'] })
  docs.set('conversations/theirs', { members: ['carol', 'dave'] })
  const inbox = await authorized(request(app).get('/api/me/conversations')).expect(200)
  assert.deepEqual(inbox.body.items.map((item) => item.id), ['ours'])
  for (let n = 1; n <= 3; n++) docs.set(`conversations/ours/messages/m${n}`, { senderId: 'alice', text: `Message ${n}`, createdAt: `2026-09-27T12:00:0${n}.000Z` })
  const path = '/api/me/conversations/ours/messages'
  const messages = await authorized(request(app).get(`${path}?limit=2`)).expect(200)
  assert.deepEqual(messages.body.items.map((item) => item.id), ['m3', 'm2'])
  assert.equal(messages.body.nextCursor, 'm2')
  const older = await authorized(request(app).get(`${path}?limit=2&cursor=m2`), 'bob').expect(200)
  assert.deepEqual(older.body.items.map((item) => item.id), ['m1'])
  assert.equal(older.body.nextCursor, null)
  await authorized(request(app).get(`${path}?cursor=missing`)).expect(400)
  await request(app).get('/api/me/conversations').expect(401)
})

test('photographer profiles require authentication, validate URLs, and derive ownership from the token', async () => {
  const { app, docs } = fixture()
  await request(app).put('/api/me/freelancer').send(photographer).expect(401)
  await request(app).get('/api/me/freelancer').expect(401)
  await authorized(request(app).get('/api/me/freelancer')).expect(200, null)
  await authorized(request(app).put('/api/me/freelancer')).send({ ...photographer, id: 'bob' }).expect(400)
  await authorized(request(app).put('/api/me/freelancer')).send({ ...photographer, website: 'javascript:alert(1)' }).expect(400)
  await authorized(request(app).put('/api/me/freelancer')).send({ ...photographer, bio: 'short' }).expect(400)
  const result = await authorized(request(app).put('/api/me/freelancer')).send(photographer).expect(200)
  assert.equal(result.body.id, 'alice')
  assert.equal(docs.get('freelancers/alice').displayName, 'Alice Photos')
  await authorized(request(app).put('/api/me/freelancer'), 'bob').send({ ...photographer, displayName: 'Bob' }).expect(200)
  assert.equal(docs.get('freelancers/alice').displayName, 'Alice Photos')
  await request(app).get('/api/freelancers/alice').expect(200)
  await authorized(request(app).put('/api/me/freelancer')).send({ ...photographer, published: false }).expect(200)
  await request(app).get('/api/freelancers/alice').expect(404)
})

test('contact and replies persist, reuse a conversation, and enforce privacy', async () => {
  const { app, docs } = fixture()
  docs.set('freelancers/alice', photographer)
  await request(app).post('/api/freelancers/alice/contact').send({ text: 'Hello' }).expect(401)
  await authorized(request(app).post('/api/freelancers/alice/contact')).send({ text: 'Hello' }).expect(400)
  await authorized(request(app).post('/api/freelancers/alice/contact'), 'bob').send({ text: '   ' }).expect(400)
  await authorized(request(app).post('/api/freelancers/alice/contact'), 'bob').send({ text: 'Hi', senderId: 'alice' }).expect(400)
  const first = await authorized(request(app).post('/api/freelancers/alice/contact'), 'bob').send({ text: 'Can we book a portrait session?' }).expect(201)
  const second = await authorized(request(app).post('/api/freelancers/alice/contact'), 'bob').send({ text: 'Next Saturday?' }).expect(201)
  assert.equal(first.body.id, second.body.id)
  assert.deepEqual(first.body.members, ['alice', 'bob'])
  const path = `/api/me/conversations/${first.body.id}/messages`
  await request(app).get(path).expect(401)
  const reply = await authorized(request(app).post(path)).send({ text: 'Yes, Saturday works.' }).expect(201)
  assert.equal(reply.body.senderId, 'alice')
  assert.equal(docs.get(`conversations/${first.body.id}`).lastMessage, 'Yes, Saturday works.')
  const messages = [...docs.entries()].filter(([key]) => key.startsWith(`conversations/${first.body.id}/messages/`))
  assert.equal(messages.length, 3)
  docs.set('conversations/private', { members: ['carol', 'dave'] })
  await authorized(request(app).get('/api/me/conversations/private/messages')).expect(403)
  await authorized(request(app).post('/api/me/conversations/private/messages')).send({ text: 'Intrusion' }).expect(403)
  await authorized(request(app).post('/api/me/conversations/missing/messages')).send({ text: 'Hello' }).expect(404)
  await authorized(request(app).post(path)).send({ text: 'x'.repeat(3001) }).expect(400)
})

test('unpublished and unavailable photographers reject new enquiries while existing replies still work', async () => {
  const { app, docs } = fixture()
  docs.set('freelancers/alice', photographer)
  const result = await authorized(request(app).post('/api/freelancers/alice/contact'), 'bob').send({ text: 'Hello' }).expect(201)
  docs.set('freelancers/alice', { ...photographer, available: false })
  await authorized(request(app).post('/api/freelancers/alice/contact'), 'bob').send({ text: 'Hello' }).expect(409)
  docs.set('freelancers/alice', { ...photographer, published: false })
  await authorized(request(app).post('/api/freelancers/alice/contact'), 'bob').send({ text: 'Hello' }).expect(404)
  await authorized(request(app).post(`/api/me/conversations/${result.body.id}/messages`)).send({ text: 'Still here' }).expect(201)
})

test('freelancer endpoints reject invalid identities, pagination and document IDs', async () => {
  const { app, docs } = fixture()
  docs.set('freelancers/alice', photographer)
  docs.set('conversations/ours', { members: ['alice', 'bob'] })
  for (const token of ['bad', 'password']) {
    const status = token === 'bad' ? 401 : 403
    await authorized(request(app).put('/api/me/freelancer'), token).send(photographer).expect(status)
    await authorized(request(app).post('/api/freelancers/alice/contact'), token).send({ text: 'Hello' }).expect(status)
    await authorized(request(app).post('/api/me/conversations/ours/messages'), token).send({ text: 'Hello' }).expect(status)
  }
  for (const path of ['/api/freelancers', '/api/me/conversations', '/api/me/conversations/ours/messages']) {
    for (const query of ['limit=0', 'limit=49', 'limit=1.5', 'cursor=invalid%2Fid']) {
      await authorized(request(app).get(`${path}?${query}`)).expect(400)
    }
  }
  await request(app).get('/api/freelancers/invalid%2Fid').expect(400)
  await authorized(request(app).get('/api/me/conversations/missing/messages')).expect(404)
  await authorized(request(app).post('/api/freelancers/missing/contact'), 'bob').send({ text: 'Hello' }).expect(404)
  assert.equal(docs.size, 3)
})

test('message pagination handles equal timestamps and rejects cursors from another conversation', async () => {
  const { app, docs } = fixture()
  docs.set('conversations/ours', { members: ['alice', 'bob'] })
  const message = { senderId: 'alice', text: 'Hello', createdAt: '2026-09-27T12:00:00.000Z' }
  for (const id of ['a', 'b', 'c']) docs.set(`conversations/ours/messages/${id}`, message)
  docs.set('conversations/theirs/messages/foreign', message)
  const path = '/api/me/conversations/ours/messages'
  const first = await authorized(request(app).get(`${path}?limit=2`)).expect(200)
  assert.deepEqual(first.body.items.map((item) => item.id), ['c', 'b'])
  const next = await authorized(request(app).get(`${path}?limit=2&cursor=${first.body.nextCursor}`)).expect(200)
  assert.deepEqual(next.body.items.map((item) => item.id), ['a'])
  assert.equal(next.body.nextCursor, null)
  await authorized(request(app).get(`${path}?cursor=foreign`)).expect(400)
})

test('contact and replies share a rate limit and blocked messages are not persisted', async () => {
  const { app, docs } = fixture()
  docs.set('freelancers/alice', photographer)
  const contact = await authorized(request(app).post('/api/freelancers/alice/contact'), 'bob').send({ text: '  Hello  ' }).expect(201)
  assert.equal(contact.body.lastMessage, 'Hello')
  const path = `/api/me/conversations/${contact.body.id}/messages`
  for (let n = 0; n < 19; n++) {
    await authorized(request(app).post(path)).send({ text: `Reply ${n}` }).expect(201)
  }
  await authorized(request(app).post(path)).send({ text: 'Blocked' }).expect(429)
  const messages = [...docs.keys()].filter((key) => key.startsWith(`conversations/${contact.body.id}/messages/`))
  assert.equal(messages.length, 20)
  assert.equal(docs.get(`conversations/${contact.body.id}`).lastMessage, 'Reply 18')
})

test('public browse works, CORS permits the configured website only', async () => {
  const { app } = fixture()
  await request(app).get('/health').expect(200)
  await request(app).get('/api/resources').set('Origin', 'http://localhost:3000').expect('Access-Control-Allow-Origin', 'http://localhost:3000').expect(200)
  await request(app).get('/api/resources').set('Origin', 'https://evil.example').expect(403)
  await request(app).get('/api/resources?limit=1000').expect(400)
  await request(app).get('/api/resources?category=unknown').expect(400)
})
test('private paths reject missing, invalid, and non-Google tokens', async () => {
  const { app } = fixture()
  await request(app).post('/api/resources').expect(401)
  await authorized(request(app).get('/api/me'), 'bad').expect(401)
  await authorized(request(app).get('/api/me'), 'password').expect(403)
  await request(app).post('/api/resources/existing/download').expect(401)
})
test('public details never expose storage paths', async () => {
  const { app } = fixture()
  const result = await request(app).get('/api/resources/existing').expect(200)
  assert.equal(result.body.filePath, undefined)
  assert.equal(result.body.previewPath, undefined)
  await request(app).get('/api/resources/missing').expect(404)
})
test('likes are idempotent, reversible, and scoped to each user', async () => {
  const { app, docs } = fixture()
  const like = (enabled, user = 'valid') => authorized(request(app).put('/api/resources/existing/likes'), user).send({ enabled })
  assert.equal((await like(true).expect(200)).body.likes, 1)
  assert.equal((await like(true).expect(200)).body.likes, 1)
  assert.equal((await like(true, 'bob').expect(200)).body.likes, 2)
  assert.equal((await like(false).expect(200)).body.likes, 1)
  assert.equal((await like(false).expect(200)).body.likes, 1)
  assert.equal(docs.has('users/alice/likes/existing'), false)
  assert.equal(docs.has('users/bob/likes/existing'), true)
  await authorized(request(app).put('/api/resources/existing/likes')).send({ enabled: 'yes' }).expect(400)
})
test('saving does not change like counts', async () => {
  const { app, docs } = fixture()
  await authorized(request(app).put('/api/resources/existing/saves')).send({ enabled: true }).expect(200)
  assert.equal(docs.get('resources/existing').likes, 0)
  assert.equal(docs.has('users/alice/saves/existing'), true)
})
test('only resource owners can edit or delete; protected fields cannot be changed', async () => {
  const { app, docs } = fixture()
  await authorized(request(app).patch('/api/resources/existing'), 'bob').send({ title: 'Stolen' }).expect(403)
  await authorized(request(app).delete('/api/resources/existing'), 'bob').expect(403)
  await authorized(request(app).patch('/api/resources/existing')).send({ ownerId: 'bob', likes: 99 }).expect(400)
  await authorized(request(app).patch('/api/resources/existing')).send({ title: 'Updated title' }).expect(200)
  assert.equal(docs.get('resources/existing').title, 'Updated title')
  await authorized(request(app).delete('/api/resources/existing')).expect(204)
  assert.equal(docs.has('resources/existing'), false)
})
function postUpload(app, buffer = png, filename = 'image.png', type = 'Image') {
  return authorized(request(app).post('/api/resources')).field('title', 'New resource').field('type', type).field('category', 'Photography').attach('file', buffer, filename)
}
test('upload persists metadata and private files using the verified creator', async () => {
  const { app, docs, files } = fixture()
  const { body } = await postUpload(app).expect(201)
  assert.equal(body.ownerId, 'alice')
  assert.equal(body.creator, 'Alice')
  assert.equal(body.filePath, undefined)
  assert.equal(files.size, 2)
  assert.equal(docs.get(`resources/${body.id}`).likes, 0)
})
test('upload rejects disguised files, missing PSD previews, and mismatched types', async () => {
  const { app, files } = fixture()
  await postUpload(app, Buffer.from('<script>alert(1)</script>'), 'image.png').expect(400)
  await postUpload(app, png, 'image.psd', 'PSD').expect(400)
  const psd = Buffer.alloc(26); psd.write('8BPS'); psd.writeUInt16BE(1, 4)
  await postUpload(app, psd, 'image.psd', 'PSD').expect(400)
  assert.equal(files.size, 0)
})
test('failed database creation cleans up uploaded files and masks internal errors', async () => {
  const { app, files } = fixture({ create: async () => { throw Error('secret database internals') } })
  const { body } = await postUpload(app).expect(500)
  assert.equal(files.size, 0)
  assert.equal(body.error.includes('secret'), false)
})
test('download returns an expiring signed URL and records a download', async () => {
  let downloaded = null
  const { app } = fixture({ download: async (id) => { downloaded = id } })
  const { body } = await authorized(request(app).post('/api/resources/existing/download')).expect(200)
  assert.equal(body.expiresIn, 300)
  assert.equal(body.url, 'https://storage.example.test/signed')
  assert.equal(downloaded, 'existing')
})
