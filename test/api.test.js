import test, { before, after } from 'node:test'
import { database, fixtureDatabase } from './helpers/database.js'
import assert from 'node:assert/strict'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { createRepository } from '../src/repository.js'

const identity = { uid: 'alice', name: 'Alice', email_verified: true, provider: 'google' }
const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000b49444154789c636000020000050001a5f645400000000049454e44ae426082', 'hex')
let db
before(async () => { db = await database() })
after(async () => { await db?.close() })
async function fixture(overrides = {}) {
  const files = new Map()
  const { client, docs } = await fixtureDatabase(db)
  docs.set('resources/existing', { title: 'Existing', type: 'Image', ownerId: 'alice', likes: 0, filePath: 'original', previewPath: 'preview', fileName: 'image.png' })
  const repository = { ...createRepository(client), ...overrides }
  const auth = { verifyToken: async (token) => {
    const identities = { valid: identity, bob: { ...identity, uid: 'bob' }, password: { ...identity, provider: 'email' }, unverified: { ...identity, email_verified: false } }
    if (!Object.hasOwn(identities, token)) throw Error('invalid')
    return identities[token]
  } }
  const storage = {
    upload: async (path, buffer) => files.set(path, buffer),
    remove: async (paths) => paths.forEach(path => files.delete(path)),
    signedDownload: async () => 'https://storage.example.test/signed',
    preview: async () => ({ buffer: png, contentType: 'image/png' }),
  }
  return { app: createApp({ repository, auth, storage, logger: { error() {} } }), files, docs, repository }
}
const authorized = (req, token = 'valid') => req.set('Authorization', `Bearer ${token}`)

const photographer = { displayName: 'Alice Photos', headline: 'Portrait photographer', location: 'Johannesburg', bio: 'Natural portraits for people and their stories.', specialty: 'Portraits', available: true, published: true, instagram: 'https://instagram.com/alice', facebook: '', tiktok: '', website: '' }

test('directory, inbox and message pagination filter correctly without leaking private records', async () => {
  const { app, docs } = await fixture()
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
  const { app, docs } = await fixture()
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
  const { app, docs } = await fixture()
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
  const { app, docs } = await fixture()
  docs.set('freelancers/alice', photographer)
  const result = await authorized(request(app).post('/api/freelancers/alice/contact'), 'bob').send({ text: 'Hello' }).expect(201)
  docs.set('freelancers/alice', { ...photographer, available: false })
  await authorized(request(app).post('/api/freelancers/alice/contact'), 'bob').send({ text: 'Hello' }).expect(409)
  docs.set('freelancers/alice', { ...photographer, published: false })
  await authorized(request(app).post('/api/freelancers/alice/contact'), 'bob').send({ text: 'Hello' }).expect(404)
  await authorized(request(app).post(`/api/me/conversations/${result.body.id}/messages`)).send({ text: 'Still here' }).expect(201)
})

test('freelancer endpoints reject invalid identities, pagination and document IDs', async () => {
  const { app, docs } = await fixture()
  docs.set('freelancers/alice', photographer)
  docs.set('conversations/ours', { members: ['alice', 'bob'] })
  for (const token of ['bad', 'password', 'unverified']) {
    const status = token === 'bad' ? 401 : 403
    for (const path of ['/api/me/freelancer', '/api/me/conversations', '/api/me/conversations/ours/messages']) {
      await authorized(request(app).get(path), token).expect(status)
    }
    await authorized(request(app).put('/api/me/freelancer'), token).send(photographer).expect(status)
    await authorized(request(app).post('/api/freelancers/alice/contact'), token).send({ text: 'Hello' }).expect(status)
    await authorized(request(app).post('/api/me/conversations/ours/messages'), token).send({ text: 'Hello' }).expect(status)
  }
  for (const path of ['/api/freelancers', '/api/me/conversations', '/api/me/conversations/ours/messages']) {
    for (const query of ['limit=0', 'limit=49', 'limit=1.5', 'limit=-1', 'limit=abc', 'limit=Infinity', 'limit=', 'limit=1&limit=2', 'cursor=', 'cursor=invalid%2Fid', `cursor=${'a'.repeat(129)}`, 'cursor=a&cursor=b']) {
      await authorized(request(app).get(`${path}?${query}`)).expect(400)
    }
  }
  await request(app).get('/api/freelancers/invalid%2Fid').expect(400)
  await authorized(request(app).get('/api/me/conversations/missing/messages')).expect(404)
  await authorized(request(app).post('/api/freelancers/missing/contact'), 'bob').send({ text: 'Hello' }).expect(404)
  assert.equal(docs.size, 3)
})

test('missing and malformed authentication headers never reach protected freelancer repositories', async () => {
  const calls = []
  const methods = ['ownFreelancer', 'saveFreelancer', 'conversations', 'contact', 'messages', 'sendMessage']
  const overrides = Object.fromEntries(methods.map((name) => [name, async () => { calls.push(name); return {} }]))
  const { app } = await fixture(overrides)
  const endpoints = [
    ['get', '/api/me/freelancer'],
    ['put', '/api/me/freelancer', photographer],
    ['get', '/api/me/conversations'],
    ['post', '/api/freelancers/alice/contact', { text: 'Hello' }],
    ['get', '/api/me/conversations/ours/messages'],
    ['post', '/api/me/conversations/ours/messages', { text: 'Hello' }],
  ]
  for (const header of [null, 'Basic valid', 'Bearer', 'Bearer valid extra']) {
    for (const [method, path, body] of endpoints) {
      let req = request(app)[method](path)
      if (header !== null) req = req.set('Authorization', header)
      if (body) req = req.send(body)
      await req.expect(401)
    }
  }
  assert.deepEqual(calls, [])
})

test('private message cursors do not reveal whether a message exists to non-members', async () => {
  const { app, docs } = await fixture()
  docs.set('conversations/private', { members: ['carol', 'dave'] })
  docs.set('conversations/private/messages/secret', { senderId: 'carol', text: 'Private text', createdAt: '2026-09-27T12:00:00.000Z' })
  const before = structuredClone([...docs])
  for (const cursor of ['secret', 'missing']) {
    const result = await authorized(request(app).get(`/api/me/conversations/private/messages?cursor=${cursor}&limit=1`)).expect(403)
    assert.deepEqual(result.body, { error: 'This conversation is private' })
  }
  await authorized(request(app).post('/api/me/conversations/private/messages')).send({ text: 'Intrusion' }).expect(403)
  assert.deepEqual([...docs], before)
})

test('freelancer lists accept the maximum page size and return every remaining record once', async () => {
  const { app, docs } = await fixture()
  docs.set('conversations/ours', { members: ['alice', 'bob'] })
  const ids = Array.from({ length: 49 }, (_, n) => `record-${String(n).padStart(2, '0')}`)
  for (const id of ids) {
    docs.set(`freelancers/${id}`, photographer)
    docs.set(`conversations/${id}`, { members: ['alice', id] })
    docs.set(`conversations/ours/messages/${id}`, { senderId: 'alice', text: id, createdAt: '2026-09-27T12:00:00.000Z' })
  }
  const cases = [
    ['/api/freelancers', ids],
    ['/api/me/conversations', ['ours', ...ids]],
    ['/api/me/conversations/ours/messages', [...ids].reverse()],
  ]
  for (const [path, expected] of cases) {
    const first = await authorized(request(app).get(`${path}?limit=48`)).expect(200)
    assert.deepEqual(first.body.items.map((item) => item.id), expected.slice(0, 48))
    assert.equal(first.body.nextCursor, expected[47])
    const next = await authorized(request(app).get(`${path}?limit=48&cursor=${first.body.nextCursor}`)).expect(200)
    assert.deepEqual(next.body.items.map((item) => item.id), expected.slice(48))
    assert.equal(next.body.nextCursor, null)
  }
})

test('inbox pagination retains membership filtering across pages and ends with a null cursor', async () => {
  const { app, docs } = await fixture()
  for (const id of ['a', 'c', 'e']) docs.set(`conversations/${id}`, { members: ['alice', id] })
  for (const id of ['b', 'd', 'f']) docs.set(`conversations/${id}`, { members: ['carol', id] })
  const path = '/api/me/conversations'
  const first = await authorized(request(app).get(`${path}?limit=2`)).expect(200)
  assert.deepEqual(first.body.items.map((item) => item.id), ['a', 'c'])
  assert.equal(first.body.nextCursor, 'c')
  const next = await authorized(request(app).get(`${path}?limit=2&cursor=${first.body.nextCursor}`)).expect(200)
  assert.deepEqual(next.body.items.map((item) => item.id), ['e'])
  assert.equal(next.body.nextCursor, null)
  const exhausted = await authorized(request(app).get(`${path}?limit=2&cursor=e`)).expect(200)
  assert.deepEqual(exhausted.body, { items: [], nextCursor: null })
  const exact = await authorized(request(app).get(`${path}?limit=3`)).expect(200)
  assert.deepEqual(exact.body.items.map((item) => item.id), ['a', 'c', 'e'])
  assert.equal(exact.body.nextCursor, null)
})

test('empty freelancer lists return empty pages and default pagination returns 24 items', async () => {
  const { app, docs } = await fixture()
  await request(app).get('/api/freelancers').expect(200, { items: [], nextCursor: null })
  await authorized(request(app).get('/api/me/conversations')).expect(200, { items: [], nextCursor: null })
  docs.set('conversations/ours', { members: ['alice', 'bob'] })
  await authorized(request(app).get('/api/me/conversations/ours/messages')).expect(200, { items: [], nextCursor: null })
  for (let n = 0; n < 25; n++) docs.set(`freelancers/photographer-${String(n).padStart(2, '0')}`, photographer)
  const first = await request(app).get('/api/freelancers').expect(200)
  assert.equal(first.body.items.length, 24)
  assert.equal(first.body.nextCursor, 'photographer-23')
  const next = await request(app).get(`/api/freelancers?cursor=${first.body.nextCursor}`).expect(200)
  assert.deepEqual(next.body.items.map((item) => item.id), ['photographer-24'])
  assert.equal(next.body.nextCursor, null)
})

test('message pagination handles equal timestamps and rejects cursors from another conversation', async () => {
  const { app, docs } = await fixture()
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
  const { app, docs } = await fixture()
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
  const { app } = await fixture()
  await request(app).get('/health').expect(200)
  await request(app).get('/api/resources').set('Origin', 'http://localhost:3000').expect('Access-Control-Allow-Origin', 'http://localhost:3000').expect(200)
  await request(app).get('/api/resources').set('Origin', 'https://evil.example').expect(403)
  await request(app).get('/api/resources?limit=1000').expect(400)
  await request(app).get('/api/resources?category=unknown').expect(400)
})
test('private paths reject missing, invalid, and non-Google tokens', async () => {
  const { app } = await fixture()
  await request(app).post('/api/resources').expect(401)
  await authorized(request(app).get('/api/me'), 'bad').expect(401)
  await authorized(request(app).get('/api/me'), 'password').expect(403)
  await request(app).post('/api/resources/existing/download').expect(401)
})
test('public details never expose storage paths', async () => {
  const { app } = await fixture()
  const result = await request(app).get('/api/resources/existing').expect(200)
  assert.equal(result.body.filePath, undefined)
  assert.equal(result.body.previewPath, undefined)
  await request(app).get('/api/resources/missing').expect(404)
})
test('likes are idempotent, reversible, and scoped to each user', async () => {
  const { app, docs } = await fixture()
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
  const { app, docs } = await fixture()
  await authorized(request(app).put('/api/resources/existing/saves')).send({ enabled: true }).expect(200)
  assert.equal(docs.get('resources/existing').likes, 0)
  assert.equal(docs.has('users/alice/saves/existing'), true)
})
test('only resource owners can edit or delete; protected fields cannot be changed', async () => {
  const { app, docs } = await fixture()
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
  const { app, docs, files } = await fixture()
  const { body } = await postUpload(app).expect(201)
  assert.equal(body.ownerId, 'alice')
  assert.equal(body.creator, 'Alice')
  assert.equal(body.filePath, undefined)
  assert.equal(files.size, 2)
  assert.equal(docs.get(`resources/${body.id}`).likes, 0)
})
test('upload rejects disguised files, missing PSD previews, and mismatched types', async () => {
  const { app, files } = await fixture()
  await postUpload(app, Buffer.from('<script>alert(1)</script>'), 'image.png').expect(400)
  await postUpload(app, png, 'image.psd', 'PSD').expect(400)
  const psd = Buffer.alloc(26); psd.write('8BPS'); psd.writeUInt16BE(1, 4)
  await postUpload(app, psd, 'image.psd', 'PSD').expect(400)
  assert.equal(files.size, 0)
})
test('failed database creation cleans up uploaded files and masks internal errors', async () => {
  const { app, files } = await fixture({ create: async () => { throw Error('secret database internals') } })
  const { body } = await postUpload(app).expect(500)
  assert.equal(files.size, 0)
  assert.equal(body.error.includes('secret'), false)
})
test('download returns an expiring signed URL and records a download', async () => {
  let downloaded = null
  const { app } = await fixture({ download: async (id) => { downloaded = id } })
  const { body } = await authorized(request(app).post('/api/resources/existing/download')).expect(200)
  assert.equal(body.expiresIn, 300)
  assert.equal(body.url, 'https://storage.example.test/signed')
  assert.equal(downloaded, 'existing')
})

test('database permissions block browser roles from RPC and every application table', async () => {
  await fixture()
  for (const role of ['anon', 'authenticated']) {
    await db.exec(`set role ${role}`)
    try {
      await assert.rejects(db.query("select public.setla_api('activity','alice','{}')"), { code: '42501' })
      for (const table of ['profiles','resources','reactions','freelancers','conversations','messages']) {
        await assert.rejects(db.query(`select * from public.${table}`), { code: '42501' })
      }
    } finally { await db.exec('reset role') }
  }
  const policies = await db.query("select relrowsecurity from pg_class where relname in ('profiles','resources','reactions','freelancers','conversations','messages') and relnamespace='public'::regnamespace")
  assert.equal(policies.rows.length, 6)
  assert.ok(policies.rows.every(row => row.relrowsecurity))
  const { rows } = await db.query("select * from storage.buckets where id='setla-resources'")
  assert.equal(rows[0].public, false)
  assert.equal(rows[0].file_size_limit, 26214400)
})

test('resource search, literal wildcards, category and owner pagination execute in PostgreSQL', async () => {
  const { app, docs } = await fixture()
  docs.set('resources/a', { title: 'African 100% design', type:'Poster', category:'African Designs', ownerId:'alice' })
  docs.set('resources/b', { title: 'African landscape', type:'Image', ownerId:'bob' })
  docs.set('resources/c', { title: 'African portrait', type:'Image', ownerId:'alice' })
  const first = await request(app).get('/api/resources?q=AFRICAN&limit=2').expect(200)
  assert.deepEqual(first.body.items.map(x=>x.id),['a','b'])
  const second = await request(app).get('/api/resources?q=AFRICAN&limit=2&cursor=b').expect(200)
  assert.deepEqual(second.body.items.map(x=>x.id),['c'])
  assert.equal(second.body.nextCursor,null)
  const literal = await request(app).get('/api/resources?q=%25').expect(200)
  assert.deepEqual(literal.body.items.map(x=>x.id),['a'])
  const category = await request(app).get('/api/resources?category=African%20designs').expect(200)
  assert.deepEqual(category.body.items.map(x=>x.id),['a'])
  const mine = await authorized(request(app).get('/api/me/resources?limit=2')).expect(200)
  assert.deepEqual(mine.body.items.map(x=>x.id),['a','c'])
  assert.equal(mine.body.nextCursor,'c')
  assert.ok(first.body.items.every(x=>!('filePath' in x) && !('previewPath' in x)))
})

test('saved resources are private, paginate and cascade when a resource is deleted', async () => {
  const { app } = await fixture()
  await authorized(request(app).put('/api/resources/existing/saves')).send({enabled:true}).expect(200)
  const saved = await authorized(request(app).get('/api/me/saved')).expect(200)
  assert.deepEqual(saved.body.items.map(x=>x.id),['existing'])
  await authorized(request(app).get('/api/me/saved'),'bob').expect(200,{items:[],nextCursor:null})
  await authorized(request(app).delete('/api/resources/existing')).expect(204)
  await authorized(request(app).get('/api/me/activity')).expect(200,{liked:[],saved:[]})
})

test('profile sync, download counters and public preview work', async () => {
  const { app, repository } = await fixture()
  const profile = await authorized(request(app).get('/api/me')).expect(200)
  assert.equal(profile.body.uid,'alice')
  assert.equal(profile.body.displayName,'Alice')
  await authorized(request(app).post('/api/resources/existing/download')).expect(200)
  await authorized(request(app).post('/api/resources/existing/download')).expect(200)
  assert.equal((await repository.getResource('existing')).downloads,2)
  await request(app).get('/api/resources/existing/preview').expect('Content-Type',/image\/png/).expect(200)
})

test('failed message insert rolls back conversation creation and last-message updates', async () => {
  const { repository, docs } = await fixture()
  docs.set('freelancers/alice',photographer)
  await assert.rejects(repository.contact({...identity,uid:'bob'},'alice',''), { code: '23514' })
  assert.equal((await repository.conversations('bob',{})).items.length,0)
  const thread = await repository.contact({...identity,uid:'bob'},'alice','Valid enquiry')
  await assert.rejects(repository.sendMessage('alice',thread.id,''), { code: '23514' })
  const inbox = await repository.conversations('alice',{})
  assert.equal(inbox.items[0].lastMessage,'Valid enquiry')
  assert.equal((await repository.messages('alice',thread.id,{})).items.length,1)
})
