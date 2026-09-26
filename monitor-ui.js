/* Email dashboard monitor only. Agent status and Daily brief UI intentionally removed. */
(() => {
  let generation=0;
  async function refresh(){
    const ticket=++generation;
    const {data:{session}}=await sb.auth.getSession();if(ticket!==generation)return;
    if(!isOwnerSession(session)){monitorEmails=[];renderImportantEmails();return}
    const [sources,mail]=await Promise.all([
      sb.from('monitor_sources').select('kind,last_success_at').order('kind'),
      sb.from('monitor_records').select('payload').eq('kind','email').neq('status','deleted').eq('payload->>dashboard','true').gte('occurred_at',new Date(Date.now()-14*86400000).toISOString()).order('occurred_at',{ascending:false}).limit(8)
    ]);
    if(ticket!==generation)return;
    if(sources.error||mail.error){monitorEmails=[];monitorEmailMessage='Monitoring unavailable. Check setup and sign-in.';renderImportantEmails();return}
    monitorEmails=(mail.data||[]).map(r=>r.payload);
    monitorEmailMessage=(sources.data||[]).some(s=>s.kind==='gmail'&&s.last_success_at)?'No recent important mail was selected by the monitor.':'Gmail has not completed its first sync.';
    renderImportantEmails();
  }
  window.addEventListener('roggy-auth',()=>{generation++;monitorEmails=[];renderImportantEmails();refresh().catch(()=>{})});
  refresh().catch(()=>{monitorEmailMessage='Monitoring unavailable.';renderImportantEmails()});
  setInterval(()=>{if(!document.hidden)refresh().catch(()=>{})},60000);
})();