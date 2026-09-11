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
  function ref(path) { return { path, collection: (name) => ({ doc: (id) => ref(`${path}/${name}/${id}`) }) } }
  const db = {
    collection: (name) => ({ doc: (id) => ({ ...ref(`${name}/${id}`), create: async (value) => docs.set(`${name}/${id}`, value), get: async () => ({ exists: docs.has(`${name}/${id}`), id, data: () => docs.get(`${name}/${id}`) }) }) }),
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
