import { PGlite } from '@electric-sql/pglite'
import { readFile } from 'node:fs/promises'

export async function database() {
  const db = new PGlite()
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema storage;
    create table storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);`)
  await db.exec(await readFile(new URL('../../supabase/migrations/202610220001_setla.sql', import.meta.url), 'utf8'))
  return db
}

// PostgreSQL executes the production migration and RPC; only the HTTP transport
// to hosted Supabase is substituted. Seed helpers retain readable fixture paths.
export async function fixtureDatabase(db) {
  await db.exec('truncate public.profiles, public.resources, public.reactions, public.freelancers, public.conversations, public.messages cascade')
  const docs = new Map()
  const pending = new Map()
  docs.set = (key, value) => { pending.set(key,value); Map.prototype.set.call(docs,key,value); return docs }
  async function insert(table, row, key = 'id') {
    const cols = Object.keys(row)
    await db.query(`insert into public.${table} (${cols.map(k=>`"${k}"`).join(',')}) values (${cols.map((_,i)=>`$${i+1}`).join(',')}) on conflict (${key}) do update set ${cols.filter(k=>k!==key).map(k=>`"${k}"=excluded."${k}"`).join(',')}`, Object.values(row))
  }
  async function flush() {
    for (const [path,value] of pending) {
      const [table,id,sub,messageId] = path.split('/')
      if (sub === 'messages') {
        if (!(await db.query('select id from public.conversations where id=$1',[id])).rows.length) {
          await insert('conversations',{id,photographerId:'carol',clientId:'dave',members:['carol','dave'],names:{},lastMessage:''})
        }
        await insert('messages',{id:messageId,conversationId:id,...value})
      } else if (table === 'resources') {
        await insert(table,{id,title:'Existing',type:'Image',category:'Photography',ownerId:'alice',creator:'Alice',image:`/api/resources/${id}/preview`,filePath:'original',previewPath:'preview',fileName:'image.png',fileSize:100,...value})
      } else if (table === 'conversations') {
        await insert(table,{id,photographerId:value.members[0],clientId:value.members[1],names:{},lastMessage:'',...value})
      } else await insert(table,{id,...value})
    }
    pending.clear()
  }
  async function refresh() {
    docs.clear()
    for (const table of ['resources','freelancers','conversations','messages','reactions','profiles']) {
      const { rows } = await db.query(`select to_jsonb(t) as item from public.${table} t`)
      for (const {item} of rows) {
        let path = `${table}/${item.id}`
        if (table==='messages') path=`conversations/${item.conversationId}/messages/${item.id}`
        if (table==='reactions') path=`users/${item.uid}/${item.kind}/${item.resourceId}`
        if (table==='profiles') path=`users/${item.uid}`
        Map.prototype.set.call(docs,path,item)
      }
    }
  }
  const client = { async rpc(name, {operation,actor,args}) {
    await flush()
    try {
      await db.exec('set role service_role')
      const {rows} = await db.query('select public.setla_api($1,$2,$3::jsonb) as data',[operation,actor,args])
      await db.exec('reset role')
      await refresh()
      return {data:rows[0].data,error:null}
    } catch (error) {
      await db.exec('reset role')
      return {data:null,error}
    }
  } }
  return {client,docs,flush,refresh}
}
