/* Private monitoring state remains in memory, never localStorage or the SW cache. */
(() => {
  let generation=0;
  const status=document.createElement('section');status.className='home-section monitor-section';status.id='monitorSection';
  document.querySelector('.email-section').after(status);
  const brief=document.createElement('section');brief.className='home-section';brief.id='monitorBrief';status.after(brief);
  function clear(){monitorEmails=[];status.textContent='Sign in to view monitoring status.';brief.replaceChildren();renderImportantEmails()}
  async function refresh(){
    const ticket=++generation;
    const {data:{session}}=await sb.auth.getSession();if(ticket!==generation)return;
    if(!isOwnerSession(session)){clear();return}
    const [sources,mail,latest]=await Promise.all([
      sb.from('monitor_sources').select('kind,external_id,enabled,last_attempt_at,last_success_at,error_code,interval_seconds').order('kind'),
      sb.from('monitor_records').select('payload').eq('kind','email').neq('status','deleted').eq('payload->>dashboard','true').gte('occurred_at',new Date(Date.now()-14*86400000).toISOString()).order('occurred_at',{ascending:false}).limit(8),
      sb.from('monitor_records').select('payload').eq('kind','brief').neq('status','deleted').order('synced_at',{ascending:false}).limit(1)
    ]);
    if(ticket!==generation)return;
    if(sources.error||mail.error||latest.error){monitorEmails=[];monitorEmailMessage='Monitoring unavailable. Check setup and sign-in.';status.textContent='Monitoring data could not be loaded.';brief.replaceChildren();renderImportantEmails();return}
    monitorEmails=(mail.data||[]).map(r=>r.payload);
    monitorEmailMessage=sources.data.some(s=>s.kind==='gmail'&&s.last_success_at)?'No recent important mail was selected by the monitor.':'Gmail has not completed its first sync.';
    renderImportantEmails();
    status.innerHTML='<div class="section-head"><h3>Agent status</h3></div>'+(sources.data.length?sources.data.map(s=>{
      const stale=!s.last_success_at||Date.now()-Date.parse(s.last_success_at)>s.interval_seconds*2000;
      const state=s.error_code?'Needs attention':!s.enabled?'Disabled':stale?'Awaiting sync':'Healthy';
      return '<div class="monitor-source"><b>'+esc(s.kind)+'</b><span>'+esc(state)+'</span><small>'+esc(s.last_success_at?'Last success '+new Date(s.last_success_at).toLocaleString():'Never synced')+(s.error_code?' · '+esc(s.error_code):'')+'</small></div>';
    }).join(''):'<p>No sources configured. Complete the worker setup to begin monitoring.</p>');
    const b=latest.data?.[0]?.payload;
    if(!b){brief.innerHTML='<h3>Daily brief</h3><p>No brief has been generated yet.</p>';return}
    const stale=Date.now()-Date.parse(b.generated_at)>2*3600000;
    brief.innerHTML='<h3>Daily brief</h3><small>'+esc(b.date)+' · '+esc(stale?'May be out of date':'Updated '+new Date(b.generated_at).toLocaleTimeString())+'</small><p>'+esc(b.sections.TODAY.today.length)+' calendar events · '+esc(b.sections.IMPORTANT.length)+' important emails · '+esc(b.sections.PACKAGES.length)+' package updates</p>'+b.alerts.slice(0,6).map(a=>'<div class="monitor-alert"><b>'+esc(a.severity)+' · '+esc(a.type.replaceAll('_',' '))+'</b><p>'+esc(a.reason)+'</p></div>').join('');
  }
  window.addEventListener('roggy-auth',()=>{generation++;clear();refresh().catch(()=>{status.textContent='Monitoring unavailable.'})});
  refresh().catch(()=>{status.textContent='Monitoring unavailable.'});
  setInterval(()=>{if(!document.hidden)refresh().catch(()=>{status.textContent='Monitoring unavailable.'})},60000);
})();
