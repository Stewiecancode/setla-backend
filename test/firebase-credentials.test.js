import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { firebaseCredential, normalizePrivateKey } from '../src/firebase-credentials.js'

// Disposable test material; no real service-account credentials are read.
const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
})

test('Firebase keys accept PEM, escaped newlines, CRLF and dashboard quotes', () => {
  const pem = privateKey.trim()
  for (const value of [privateKey, `  ${privateKey}  `, JSON.stringify(privateKey), `'${pem}'`, pem.replace(/\n/g, '\\n'), pem.replace(/\n/g, '\r\n'), pem.replace(/\n/g, '\\r\\n')]) {
    assert.equal(normalizePrivateKey(value).trim(), pem)
    assert.equal(typeof firebaseCredential({ FIREBASE_PROJECT_ID: 'test-project', FIREBASE_CLIENT_EMAIL: ' test@test-project.iam.gserviceaccount.com ', FIREBASE_PRIVATE_KEY: value }).getAccessToken, 'function')
  }
})

test('invalid keys report actionable errors without exposing the supplied secret', () => {
  for (const value of ['', 'secret-key-id', JSON.stringify({ private_key: privateKey }), privateKey.slice(0, 100)]) {
    assert.throws(() => normalizePrivateKey(value), (error) => {
      assert.match(error.message, /Invalid FIREBASE_PRIVATE_KEY/)
      if (value) assert.equal(error.message.includes(value), false)
      return true
    })
  }
})

test('partial service-account configuration fails before using fallback credentials', () => {
  for (const env of [{ FIREBASE_CLIENT_EMAIL: 'test@example.com' }, { FIREBASE_PRIVATE_KEY: privateKey }]) {
    assert.throws(() => firebaseCredential(env), /Set both FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY/)
  }
})
