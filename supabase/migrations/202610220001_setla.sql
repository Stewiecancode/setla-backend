-- Apply once through `supabase db push` or the Supabase SQL editor.
-- Browsers use Auth only. All application data flows through the Express API.
begin;
create table public.profiles (
  uid text primary key,
  "displayName" text not null,
  email text not null default '',
  "photoURL" text not null default '',
  "updatedAt" timestamptz not null default now()
);
create table public.resources (
  id text primary key,
  "ownerId" text not null,
  title text not null check (length(title) between 3 and 120),
  description text not null default '' check (length(description) <= 2000),
  type text not null check (type in ('Image','PSD','Poster','Flyer')),
  category text not null check (category in ('Photography','Events','Business','People','Architecture','Education','Social Media','African Designs','Other')),
  creator text not null,
  image text not null,
  height text not null default 'aspect-[4/5]',
  accent text not null default 'stone',
  likes integer not null default 0 check (likes >= 0),
  downloads integer not null default 0 check (downloads >= 0),
  "filePath" text not null,
  "previewPath" text not null,
  "fileName" text not null,
  "fileSize" bigint not null check ("fileSize" between 1 and 26214400),
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz
);
create index resources_owner_id on public.resources ("ownerId", id);
create index resources_type_id on public.resources (type, id);
create index resources_category_id on public.resources (category, id);
create table public.reactions (
  uid text not null,
  "resourceId" text not null references public.resources(id) on delete cascade,
  kind text not null check (kind in ('likes','saves')),
  "createdAt" timestamptz not null default now(),
  primary key (uid, kind, "resourceId")
);
create table public.freelancers (
  id text primary key,
  "displayName" text not null check (length("displayName") between 2 and 80),
  headline text not null check (length(headline) between 3 and 120),
  location text not null default '' check (length(location) <= 120),
  bio text not null check (length(bio) between 20 and 2000),
  specialty text not null check (specialty in ('Portraits','Weddings','Events','Products','Fashion','Architecture','Other')),
  available boolean not null default true,
  published boolean not null default false,
  instagram text not null default '',
  facebook text not null default '',
  tiktok text not null default '',
  website text not null default '',
  "updatedAt" timestamptz not null default now()
);
create index freelancers_published_id on public.freelancers (published, id);
create table public.conversations (
  id text primary key,
  "photographerId" text not null,
  "clientId" text not null,
  members text[] not null check (cardinality(members) = 2),
  names jsonb not null,
  "lastMessage" text not null,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now(),
  unique ("photographerId", "clientId"),
  check ("photographerId" <> "clientId"),
  check (members = array["photographerId", "clientId"])
);
create index conversations_members on public.conversations using gin (members);
create table public.messages (
  id text primary key default gen_random_uuid()::text,
  "conversationId" text not null references public.conversations(id) on delete cascade,
  "senderId" text not null,
  text text not null check (length(btrim(text)) between 1 and 3000),
  "createdAt" timestamptz not null default now()
);
create index messages_page on public.messages ("conversationId", "createdAt" desc, id desc);

-- No anon/authenticated grants or policies: deny direct client database access.
alter table public.profiles enable row level security;
alter table public.resources enable row level security;
alter table public.reactions enable row level security;
alter table public.freelancers enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
revoke all on public.profiles, public.resources, public.reactions, public.freelancers, public.conversations, public.messages from anon, authenticated;
grant select, insert, update, delete on public.profiles, public.resources, public.reactions, public.freelancers, public.conversations, public.messages to service_role;

-- One RPC invocation is one transaction. Explicit row locks serialize reactions,
-- edits and messages; unique participant pairs serialize repeat enquiries.
create function public.setla_api(operation text, actor text default null, args jsonb default '{}'::jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  resource public.resources;
  photographer public.freelancers;
  thread public.conversations;
  message public.messages;
  last_message public.messages;
  result jsonb;
  rows jsonb;
  page_limit integer := least(48, greatest(1, coalesce((args->>'limit')::integer, 24)));
  cursor_id text := args->>'cursor';
  target text := args->>'id';
  changed integer;
  wanted boolean;
  reaction_kind text;
  now_at timestamptz := clock_timestamp();
begin
  if operation not in ('resource','resources','freelancers','freelancer','download') and actor is null then
    raise sqlstate 'PT403' using message = 'Authentication required';
  end if;
  case operation
  when 'resource' then
    select * into resource from public.resources where id = target;
    if not found then raise sqlstate 'PT404' using message = 'Resource not found'; end if;
    return to_jsonb(resource);
  when 'resources', 'mine', 'saved' then
    select coalesce(jsonb_agg(item order by id), '[]'::jsonb) into rows from (
      select r.id, to_jsonb(r) - 'filePath' - 'previewPath' as item from public.resources r
      where (cursor_id is null or r.id > cursor_id)
        and (operation <> 'mine' or r."ownerId" = actor)
        and (operation <> 'saved' or exists(select 1 from public.reactions a where a.uid = actor and a.kind = 'saves' and a."resourceId" = r.id))
        and (operation <> 'resources' or (
          (coalesce(args->>'category','All resources') = 'All resources'
            or r.type = case args->>'category' when 'Free images' then 'Image' when 'PSD templates' then 'PSD' when 'Posters' then 'Poster' when 'Flyers' then 'Flyer' end
            or (args->>'category' = 'African designs' and r.category = 'African Designs'))
          and strpos(lower(concat_ws(' ', r.title, r.type, r.creator, r.category, r.description)), lower(coalesce(args->>'q',''))) > 0
        ))
      order by r.id limit page_limit + 1
    ) page;
  when 'profile' then
    insert into public.profiles(uid, "displayName", email, "photoURL", "updatedAt")
      values(actor, args->>'displayName', args->>'email', args->>'photoURL', now_at)
      on conflict(uid) do update set "displayName"=excluded."displayName", email=excluded.email, "photoURL"=excluded."photoURL", "updatedAt"=excluded."updatedAt"
      returning to_jsonb(profiles) into result;
    return result;
  when 'activity' then
    return jsonb_build_object(
      'liked', coalesce((select jsonb_agg("resourceId" order by "resourceId") from public.reactions where uid=actor and kind='likes'), '[]'::jsonb),
      'saved', coalesce((select jsonb_agg("resourceId" order by "resourceId") from public.reactions where uid=actor and kind='saves'), '[]'::jsonb));
  when 'create_resource' then
    insert into public.resources select * from jsonb_populate_record(null::public.resources,
      args || jsonb_build_object('ownerId', actor, 'likes', 0, 'downloads', 0, 'createdAt', now_at)) returning * into resource;
    return to_jsonb(resource) - 'filePath' - 'previewPath';
  when 'reaction' then
    reaction_kind := args->>'kind'; wanted := (args->>'enabled')::boolean;
    if reaction_kind not in ('likes','saves') or wanted is null then raise sqlstate 'PT400' using message='Invalid reaction'; end if;
    select * into resource from public.resources where id=target for update;
    if not found then raise sqlstate 'PT404' using message='Resource not found'; end if;
    if wanted then
      insert into public.reactions(uid,"resourceId",kind) values(actor,target,reaction_kind) on conflict do nothing;
      get diagnostics changed = row_count;
    else
      delete from public.reactions where uid=actor and "resourceId"=target and kind=reaction_kind;
      get diagnostics changed = row_count;
      changed := -changed;
    end if;
    if reaction_kind='likes' then
      update public.resources set likes=greatest(0,likes+changed) where id=target returning * into resource;
    end if;
    return jsonb_build_object('enabled',wanted,'likes',resource.likes);
  when 'download' then
    update public.resources set downloads=downloads+1 where id=target;
    if not found then raise sqlstate 'PT404' using message='Resource not found'; end if;
    return null;
  when 'update_resource', 'remove_resource' then
    select * into resource from public.resources where id=target for update;
    if not found then raise sqlstate 'PT404' using message='Resource not found'; end if;
    if resource."ownerId" <> actor then raise sqlstate 'PT403' using message='Only the creator can edit or delete this resource'; end if;
    if operation='remove_resource' then
      delete from public.resources where id=target;
      return to_jsonb(resource);
    end if;
    update public.resources set title=coalesce(args->'changes'->>'title',title),
      description=coalesce(args->'changes'->>'description',description),
      category=coalesce(args->'changes'->>'category',category), "updatedAt"=now_at
      where id=target returning * into resource;
    return to_jsonb(resource) - 'filePath' - 'previewPath';
  when 'freelancers' then
    select coalesce(jsonb_agg(item order by id),'[]'::jsonb) into rows from (
      select id,to_jsonb(f) as item from public.freelancers f where published and (cursor_id is null or id>cursor_id) order by id limit page_limit+1
    ) page;
  when 'freelancer', 'own_freelancer' then
    select * into photographer from public.freelancers where id=case when operation='own_freelancer' then actor else target end;
    if operation='own_freelancer' then return case when found then to_jsonb(photographer) else null end; end if;
    if not found or not photographer.published then raise sqlstate 'PT404' using message='Photographer not found'; end if;
    return to_jsonb(photographer);
  when 'save_freelancer' then
    insert into public.freelancers select * from jsonb_populate_record(null::public.freelancers,args || jsonb_build_object('id',actor,'updatedAt',now_at))
      on conflict(id) do update set "displayName"=excluded."displayName", headline=excluded.headline, location=excluded.location,
        bio=excluded.bio,specialty=excluded.specialty,available=excluded.available,published=excluded.published,
        instagram=excluded.instagram,facebook=excluded.facebook,tiktok=excluded.tiktok,website=excluded.website,"updatedAt"=excluded."updatedAt"
      returning * into photographer;
    return to_jsonb(photographer);
  when 'conversations' then
    select coalesce(jsonb_agg(item order by id),'[]'::jsonb) into rows from (
      select id,to_jsonb(c) - 'clientId' as item from public.conversations c
      where members @> array[actor] and (cursor_id is null or id>cursor_id) order by id limit page_limit+1
    ) page;
  when 'contact' then
    if actor=target then raise sqlstate 'PT400' using message='You cannot contact yourself'; end if;
    select * into photographer from public.freelancers where id=target for share;
    if not found or not photographer.published then raise sqlstate 'PT404' using message='Photographer not found'; end if;
    if not photographer.available then raise sqlstate 'PT409' using message='This photographer is not accepting new enquiries'; end if;
    insert into public.conversations(id,"photographerId","clientId",members,names,"lastMessage","createdAt","updatedAt")
      values(gen_random_uuid()::text,target,actor,array[target,actor],jsonb_build_object(target,photographer."displayName",actor,args->>'name'),args->>'text',now_at,now_at)
      on conflict("photographerId","clientId") do update set "lastMessage"=excluded."lastMessage","updatedAt"=clock_timestamp()
      returning * into thread;
    insert into public.messages("conversationId","senderId",text,"createdAt") values(thread.id,actor,args->>'text',thread."updatedAt");
    return to_jsonb(thread) - 'clientId';
  when 'messages', 'send_message' then
    select * into thread from public.conversations where id=target for update;
    if not found then raise sqlstate 'PT404' using message='Conversation not found'; end if;
    if not actor=any(thread.members) then raise sqlstate 'PT403' using message='This conversation is private'; end if;
    if operation='send_message' then
      now_at := clock_timestamp();
      insert into public.messages("conversationId","senderId",text,"createdAt") values(target,actor,args->>'text',now_at) returning * into message;
      update public.conversations set "lastMessage"=message.text,"updatedAt"=now_at where id=target;
      return to_jsonb(message) - 'conversationId';
    end if;
    if cursor_id is not null then
      select * into last_message from public.messages where id=cursor_id and "conversationId"=target;
      if not found then raise sqlstate 'PT400' using message='Invalid message cursor'; end if;
    end if;
    select coalesce(jsonb_agg(item order by "createdAt" desc,id desc),'[]'::jsonb) into rows from (
      select id,"createdAt",to_jsonb(m) - 'conversationId' as item from public.messages m where "conversationId"=target
        and (cursor_id is null or ("createdAt",id)<(last_message."createdAt",last_message.id))
      order by "createdAt" desc,id desc limit page_limit+1
    ) page;
  else
    raise sqlstate 'PT400' using message='Unknown operation';
  end case;
  return jsonb_build_object('items',case when jsonb_array_length(rows)>page_limit then rows-page_limit else rows end,
    'nextCursor',case when jsonb_array_length(rows)>page_limit then rows->(page_limit-1)->>'id' else null end);
end;
$$;
revoke all on function public.setla_api(text,text,jsonb) from public, anon, authenticated;
grant execute on function public.setla_api(text,text,jsonb) to service_role;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('setla-resources','setla-resources',false,26214400,array['image/png','image/jpeg','image/webp','image/vnd.adobe.photoshop'])
on conflict(id) do update set public=false,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;
-- No storage.objects policies: only the backend can upload, read or sign files.
commit;
