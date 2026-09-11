import 'dotenv/config'
import { applicationDefault, cert, initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { getFirestore } from 'firebase-admin/firestore'
import { getStorage } from 'firebase-admin/storage'
import { createApp } from './app.js'
import { createRepository } from './repository.js'

for (const key of ['FIREBASE_PROJECT_ID', 'FIREBASE_STORAGE_BUCKET', 'FRONTEND_ORIGINS']) {
  if (!process.env[key]) throw new Error(`Missing ${key}. Copy .env.example to .env and configure Firebase.`)
}
const credential = process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY
  ? cert({ projectId: process.env.FIREBASE_PROJECT_ID, clientEmail: process.env.FIREBASE_CLIENT_EMAIL, privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') })
  : applicationDefault()
initializeApp({ credential, projectId: process.env.FIREBASE_PROJECT_ID, storageBucket: process.env.FIREBASE_STORAGE_BUCKET })
const app = createApp({ repository: createRepository(getFirestore()), auth: getAuth(), bucket: getStorage().bucket(), origins: process.env.FRONTEND_ORIGINS.split(',').map((origin) => origin.trim()), trustProxy: Number(process.env.TRUST_PROXY || 0) })
const server = app.listen(Number(process.env.PORT || 4000), () => console.log(`Setla API listening on port ${process.env.PORT || 4000}`))
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(1), 10000).unref() })
