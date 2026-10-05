import { config, Store, MonitorError, failure, pages } from './core.mjs';
import { googleClient } from './google.mjs';

async function main() {
  const env=config(),store=new Store(env),mode=process.argv[2];
  const add=async(kind,external_id,interval_seconds,enabled)=>{
    // Existing sync cursors and historical status are deliberately omitted.
    await store.api('monitor_sources?on_conflict=user_id,kind,external_id',{method:'POST',headers:{Prefer:'resolution=merge-duplicates,return=representation'},
      body:JSON.stringify({user_id:env.MONITOR_USER_ID,kind,external_id,interval_seconds,enabled,
        next_run_at:new Date().toISOString(),error_code:null})});
  };
  if(mode==='list-calendars') {
    const get=await googleClient(env);const list=await pages(get,'calendar/v3/users/me/calendarList');
    console.log(JSON.stringify(list.items.map(c=>({id:c.id,name:c.summary,primary:!!c.primary})),null,2));return;
  }
  if(mode==='google-services' || mode==='tasks' || mode==='people' || mode==='drive') {
    const get=await googleClient(env),profile=await get('gmail/v1/users/me/profile');
    const modes = mode === 'google-services' ? ['tasks','people','drive'] : [mode];
    if (modes.includes('tasks')) await get('tasks/v1/users/@me/lists',{maxResults:'1'});
    if (modes.includes('people')) await get('people/v1/people/me/connections',{personFields:'names,emailAddresses',pageSize:'1'});
    if (modes.includes('drive')) await get('drive/v3/files',{q:'trashed = false',spaces:'drive',pageSize:'1',fields:'files(id)'});
    if (modes.includes('tasks')) await add('google_tasks',profile.emailAddress,900,true);
    if (modes.includes('people')) await add('google_people',profile.emailAddress,1800,true);
    if (modes.includes('drive')) await add('google_drive',profile.emailAddress,21600,true);
  } else if(mode==='gmail') {
    const get=await googleClient(env),profile=await get('gmail/v1/users/me/profile');
    if(!profile.emailAddress)throw new MonitorError('GMAIL_PROFILE_REQUIRED');
    await add('gmail',profile.emailAddress,300,true);
  } else if(mode==='google') {
    const get=await googleClient(env),profile=await get('gmail/v1/users/me/profile');
    const ids=JSON.parse(env.GOOGLE_CALENDAR_IDS||'[]');
    if(!Array.isArray(ids)||!ids.length||ids.some(id=>typeof id!=='string'||!id||id==='primary'))throw new MonitorError('GOOGLE_CALENDAR_IDS_REQUIRED');
    const visible=await pages(get,'calendar/v3/users/me/calendarList');
    if(ids.some(id=>!visible.items.some(c=>c.id===id)))throw new MonitorError('CALENDAR_NOT_ACCESSIBLE');
    for(const id of ids)await add('calendar',id,300,true);
    await add('gmail',profile.emailAddress,300,true);
  }else if(mode==='finance') {
    if(!env.PLAID_ITEM_ID||!env.PLAID_ACCESS_TOKEN)throw new MonitorError('PLAID_AUTH_REQUIRED');
    await add('finance',env.PLAID_ITEM_ID,3600,true);
  }else if(mode==='brief')await add('brief','daily',900,true);
  else if(mode==='garmin')await add('garmin','pending-official-access',1800,false);
  else throw new MonitorError('USAGE_SETUP_GMAIL_GOOGLE_SERVICES_FINANCE_BRIEF_GARMIN_OR_LIST_CALENDARS');
  console.log('Source configuration saved. Run the worker once and inspect the dashboard status.');
}
main().catch(e=>{console.error(failure(e).code);process.exitCode=1});
