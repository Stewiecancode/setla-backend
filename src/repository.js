import { HttpError } from './errors.js'

export const categories = ['All resources', 'Free images', 'PSD templates', 'Posters', 'Flyers', 'African designs']
export function publicResource(data) {
  const { filePath, previewPath, ...resource } = data
  return resource
}

// Only the server's secret/service-role key may execute this RPC. Actor IDs
// always come from a token verified by Supabase Auth, never from request bodies.
export function createRepository(client) {
  async function call(operation, actor = null, args = {}) {
    const { data, error } = await client.rpc('setla_api', { operation, actor, args })
    if (error) {
      const statuses = { PT400: 400, PT403: 403, PT404: 404, PT409: 409 }
      if (statuses[error.code]) throw new HttpError(statuses[error.code], error.message)
      throw error
    }
    return data
  }
  return {
    getResource: (id) => call('resource', null, { id }),
    list: (paging) => call('resources', null, paging),
    profile: (identity) => call('profile', identity.uid, { displayName: identity.name || 'Setla creator', email: identity.email || '', photoURL: identity.picture || '' }),
    activity: (uid) => call('activity', uid),
    saved: (uid, paging) => call('saved', uid, paging),
    mine: (uid, paging) => call('mine', uid, paging),
    create: (id, value) => call('create_resource', value.ownerId, { ...value, id }),
    reaction: (uid, id, kind, enabled) => call('reaction', uid, { id, kind, enabled }),
    download: (id) => call('download', null, { id }),
    update: (uid, id, changes) => call('update_resource', uid, { id, changes }),
    remove: (uid, id) => call('remove_resource', uid, { id }),
    freelancers: (paging) => call('freelancers', null, paging),
    freelancer: (id) => call('freelancer', null, { id }),
    ownFreelancer: (uid) => call('own_freelancer', uid),
    saveFreelancer: (uid, value) => call('save_freelancer', uid, value),
    conversations: (uid, paging) => call('conversations', uid, paging),
    contact: (identity, id, text) => call('contact', identity.uid, { id, text, name: identity.name || 'Setla member' }),
    messages: (uid, id, paging) => call('messages', uid, { ...paging, id }),
    sendMessage: (uid, id, text) => call('send_message', uid, { id, text }),
  }
}
