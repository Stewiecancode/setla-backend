import { createPrivateKey } from 'node:crypto'
import { applicationDefault, cert } from 'firebase-admin/app'

export function normalizePrivateKey(value) {
  let key = value.trim()
  // Dashboard values can retain the quotes used in JSON or .env files.
  if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) {
    key = key.slice(1, -1).trim()
  }
  key = key.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').replace(/\r\n/g, '\n')
  try {
    if (createPrivateKey(key).asymmetricKeyType !== 'rsa') throw new Error('Expected RSA')
  } catch {
    throw new Error('Invalid FIREBASE_PRIVATE_KEY. Set it to the complete private_key value from your Firebase service-account JSON, including the BEGIN PRIVATE KEY and END PRIVATE KEY lines. Use real line breaks or literal \\n escapes. Do not paste the entire JSON document or a key ID.')
  }
  return key
}

export function firebaseCredential(env = process.env) {
  const clientEmail = env.FIREBASE_CLIENT_EMAIL?.trim()
  const privateKey = env.FIREBASE_PRIVATE_KEY?.trim()
  if (!clientEmail && !privateKey) return applicationDefault()
  if (!clientEmail || !privateKey) {
    throw new Error('Set both FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY, or remove both to use Application Default Credentials.')
  }
  return cert({ projectId: env.FIREBASE_PROJECT_ID, clientEmail, privateKey: normalizePrivateKey(privateKey) })
}
