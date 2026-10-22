import test from 'node:test'
import assert from 'node:assert/strict'
import { createAuth, createStorage, createSupabase } from '../src/supabase.js'

test('Auth validates the token remotely and trusts only server-managed provider metadata', async () => {
  let token
  const auth = createAuth({ auth: { getUser: async value => {
    token=value
    return {data:{user:{id:'alice',email:'alice@example.test',email_confirmed_at:'2026-10-22',app_metadata:{provider:'email'},user_metadata:{provider:'google',full_name:'Alice'}}},error:null}
  } } })
  const user = await auth.verifyToken('supabase-access-token')
  assert.equal(token,'supabase-access-token')
  assert.equal(user.provider,'email')
  assert.equal(user.uid,'alice')
  assert.equal(user.email_verified,true)
  const rejected = createAuth({auth:{getUser:async()=>({data:{user:null},error:new Error('expired')})}})
  await assert.rejects(rejected.verifyToken('expired'),/expired/)
})

test('Storage uploads privately, signs five-minute attachments, downloads previews and propagates errors', async () => {
  const calls=[]
  let fail=false
  const bucket={
    upload:async(...args)=>{calls.push(['upload',...args]);return {error:fail?new Error('upload failed'):null}},
    download:async()=>({data:new Blob(['preview'],{type:'image/png'}),error:null}),
    remove:async paths=>{calls.push(['remove',paths]);return {error:null}},
    createSignedUrl:async(...args)=>{calls.push(['signed',...args]);return {data:{signedUrl:'https://example.test/signed'},error:null}},
  }
  const storage=createStorage({storage:{from:name=>{assert.equal(name,'setla-resources');return bucket}}},'setla-resources')
  await storage.upload('original',Buffer.from('file'),'image/png')
  assert.deepEqual(calls[0][3],{contentType:'image/png',upsert:false,cacheControl:'3600'})
  assert.equal(await storage.signedDownload('original','asset.png'),'https://example.test/signed')
  assert.deepEqual(calls[1],['signed','original',300,{download:'asset.png'}])
  const preview=await storage.preview('preview')
  assert.equal(preview.contentType,'image/png')
  assert.equal(preview.buffer.toString(),'preview')
  await storage.remove(['original','preview'])
  assert.deepEqual(calls[2],['remove',['original','preview']])
  fail=true
  await assert.rejects(storage.upload('original',Buffer.from('file'),'image/png'),/upload failed/)
})

test('startup requires Supabase configuration', () => {
  assert.throws(()=>createSupabase({}),/Missing SUPABASE_URL/)
  assert.throws(()=>createSupabase({SUPABASE_URL:'https://example.supabase.co'}),/Missing SUPABASE_SECRET_KEY/)
})
