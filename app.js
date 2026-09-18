const SUPABASE_URL="https://dplvxsniyqkwlmdzqbyg.supabase.co";
const SUPABASE_KEY="sb_publishable_4WYS4v4U7PSgXesYNNJUfA_69lJaBX1";
const KEY="roggy-lists-v1";
const sb=window.supabase.createClient(SUPABASE_URL,SUPABASE_KEY,{auth:{flowType:"pkce",detectSessionInUrl:false,persistSession:true,autoRefreshToken:true}});
const $=id=>document.getElementById(id);

const seed={buy:[
["Indoor doormat","Home","Need"],["Outdoor doormat","Home","Need"],["Extended small mirror for office","Office","Want"],["Soft light for office meetings","Office","Want"],["Indoor mood lighting — lamps, LEDs, etc.","Home / Decoration","Eventually"],["Outdoor Christmas lights","Decoration","Eventually"],["Blackout curtains","Home","Need"],["Curtain rods x3","Home","Need"],["Fruit bowl","Kitchen","Want"],["Glass food storage container set","Kitchen","Need"],["Hard reusable ice packs for keeping food cold","Kitchen","Need"],["Soft reusable ice packs for injuries","Health / First Aid","Need"],["Flexible silicone ice trays","Kitchen","Need"]
].map((x,i)=>({id:"b"+(i+1),item:x[0],category:x[1],priority:x[2],quantity:x[0].includes("x3")?"3":"",status:"Looking",notes:"",deleted:false,created:"2026-09-17"})),
groceries:[{id:"g1",item:"Cuties oranges",category:"Produce",priority:"Need",quantity:"1",status:"Looking",notes:"",deleted:false,created:"2026-09-17"}]};

const FALLBACK_BASELINE=[
{dimension:"Race",category:"White",count:16},{dimension:"Race",category:"Black",count:4},{dimension:"Race",category:"Asian",count:6},{dimension:"Race",category:"Unknown",count:0},
{dimension:"Gender",category:"Woman",count:17},{dimension:"Gender",category:"Man",count:9},{dimension:"Gender",category:"Unknown",count:0},
{dimension:"Age",category:"14-25",count:1},{dimension:"Age",category:"25-39",count:17},{dimension:"Age",category:"40-59",count:3},{dimension:"Age",category:"60+",count:5},
{dimension:"Obese",category:"Yes",count:11},{dimension:"Obese",category:"No",count:15},{dimension:"Obese",category:"Unknown",count:0}
];

const IOWA={
Race:{White:87.7,Black:4.9,Asian:2.7},
Gender:{Woman:50.2,Man:49.8},
Age:{"14-25":18.45,"25-39":22.84,"40-59":28.00,"60+":30.71},
Obese:{Yes:37.5,No:62.5}
};

let data={buy:[],groceries:[]},currentPage="reminders",currentView="active",currentFilter="all";
let baseline=FALLBACK_BASELINE,drivers=[],driverView="overview",charts={};
let reminders=[],reminderView="today";

function esc(s=""){return String(s).replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[m]))}
function showErr(e,target="status"){const el=$(target);if(el)el.textContent="Sync error: "+(e?.message||e)}
function loadLocal(){try{const x=JSON.parse(localStorage.getItem(KEY));if(x?.buy&&x?.groceries)return x}catch{}return structuredClone(seed)}

async function loadLists(){
  const {data:rows,error}=await sb.from("list_items").select("*").order("created_at",{ascending:true});
  if(error){data=loadLocal();showErr(error);renderLists();return}
  data={buy:[],groceries:[]};
  for(const r of rows)data[r.list_type].push({id:r.id,item:r.item,category:r.category||"",priority:r.priority||"Need",quantity:r.quantity||"",status:r.status,notes:r.notes||"",option1:r.option1||"",price1:r.price1,link1:r.link1||"",option2:r.option2||"",price2:r.price2,link2:r.link2||"",option3:r.option3||"",price3:r.price3,link3:r.link3||"",deleted:!!r.deleted_at,created:r.created_at});
  localStorage.setItem(KEY,JSON.stringify(data));renderLists();
}
async function saveItem(x){
  localStorage.setItem(KEY,JSON.stringify(data));
  const {error}=await sb.from("list_items").update({item:x.item,category:x.category||null,priority:x.priority||null,quantity:x.quantity||null,status:x.status,notes:x.notes||null,deleted_at:x.deleted?new Date().toISOString():null}).eq("id",x.id);
  if(error)throw error;
}
async function insertItem(x){
  const {data:rows,error}=await sb.from("list_items").insert({list_type:currentPage,item:x.item,category:x.category||null,priority:x.priority||null,quantity:x.quantity||null,status:x.status,notes:x.notes||null}).select();
  if(error)throw error;if(rows?.[0])x.id=rows[0].id;localStorage.setItem(KEY,JSON.stringify(data));
}

function renderLists(){
  if(currentPage==="drivers")return;
  const arr=data[currentPage]||[],deleted=arr.filter(x=>x.deleted);
  $("deletedCount").textContent=deleted.length?`(${deleted.length})`:"";
  $("pageTitle").textContent=currentPage==="buy"?"Buy List":"Groceries";
  $("pageSubtitle").textContent=currentPage==="buy"?"Needs first. Luxuries later.":"Food and immediate grocery items.";
  document.querySelector(".toolbar").style.display=currentView==="deleted"?"none":"";
  $("summary").style.display=currentView==="deleted"?"none":"";
  $("addBtn").style.display=currentView==="deleted"?"none":"";
  $("priorityFilters").style.display=currentPage==="groceries"?"none":"";
  const active=arr.filter(x=>!x.deleted),bought=active.filter(x=>x.status==="Bought").length,ready=active.filter(x=>x.status==="Ready to Buy").length;
  $("summary").innerHTML=`<div><b>${active.length-bought}</b><span>active</span></div><div><b>${ready}</b><span>ready</span></div><div><b>${bought}</b><span>bought</span></div>`;
  const q=$("search").value.toLowerCase(),rank={Need:0,Want:1,Eventually:2};
  let shown=arr.filter(x=>currentView==="deleted"?x.deleted:!x.deleted)
    .filter(x=>currentPage==="groceries"||currentFilter==="all"||x.priority===currentFilter)
    .filter(x=>!q||[x.item,x.category,x.notes].join(" ").toLowerCase().includes(q));
  shown.sort($("sort").value==="name"?(a,b)=>a.item.localeCompare(b.item):(a,b)=>(rank[a.priority]??9)-(rank[b.priority]??9));
  $("list").innerHTML="";
  if(!shown.length){$("list").innerHTML='<div class="card empty">Nothing here yet.</div>';return}
  shown.forEach(x=>{
    const c=document.createElement("article");c.className="card "+(x.status==="Bought"?"bought":"");
    if(currentView==="deleted"){
      c.innerHTML=`<div class="deleted-row"><div><div class="item-name">${esc(x.item)}</div><div class="meta"><span>${esc(x.category||"Other")}</span></div></div><button class="restorebtn">↩ Restore</button></div>`;
      c.querySelector(".restorebtn").onclick=()=>{x.deleted=false;x.status="Looking";saveItem(x).catch(showErr);renderLists()};$("list").appendChild(c);return;
    }
    c.innerHTML=`<div class="card-summary"><button class="removebtn icon-action remove-left">✕</button><div class="summary-main"><div class="item-name">${esc(x.item)}${x.quantity&&x.quantity!=="1"?` <small>×${esc(x.quantity)}</small>`:""}</div><div class="meta"><span>${esc(x.category||"Other")}</span><span>${esc(x.status)}</span></div></div><div class="card-controls">${currentPage==="buy"?`<button class="prioritybtn icon-action" data-dir="up">↑</button><span class="badge ${esc(x.priority)}">${esc(x.priority)}</span><button class="prioritybtn icon-action" data-dir="down">↓</button>`:""}<span class="chevron">⌄</span></div></div><div class="card-details collapsed"><div class="quick"><button class="statusbtn ${x.status==="Looking"?"selected":""}" data-s="Looking">Looking</button><button class="statusbtn ${x.status==="Ready to Buy"?"selected":""}" data-s="Ready to Buy">Ready</button><button class="statusbtn ${x.status==="Bought"?"selected":""}" data-s="Bought">✓ Bought</button></div>${x.notes?`<div class="detail-notes">${esc(x.notes)}</div>`:""}${currentPage==="buy"?renderResearch(x):""}<div class="bottom-actions"><button class="editbtn">Edit details</button></div></div>`;
    c.querySelector(".card-summary").onclick=e=>{if(e.target.closest("button"))return;c.querySelector(".card-details").classList.toggle("collapsed");c.classList.toggle("expanded")};
    c.querySelector(".removebtn").onclick=()=>{x.deleted=true;saveItem(x).catch(showErr);renderLists()};
    c.querySelectorAll(".statusbtn").forEach(b=>b.onclick=()=>{x.status=b.dataset.s;saveItem(x).catch(showErr);renderLists()});
    c.querySelectorAll(".prioritybtn").forEach(b=>b.onclick=()=>changePriority(x,b.dataset.dir));
    c.querySelector(".editbtn").onclick=()=>openEdit(x);$("list").appendChild(c);
  });
}
function safeLink(url){try{const u=new URL(url);return ["http:","https:"].includes(u.protocol)?u.href:""}catch{return ""}}
function renderResearch(x){
  const opts=[1,2,3].map(i=>({name:x["option"+i],price:x["price"+i],link:safeLink(x["link"+i])})).filter(o=>o.name||o.link);
  if(!opts.length)return '<div class="research-empty">No researched options yet.</div>';
  let out='<div class="research-options"><div class="research-title">Researched options</div>';
  for(const o of opts){
    out+='<div class="research-option"><div><b>'+esc(o.name||"Product option")+'</b>'+(o.price!=null?'<span>$'+Number(o.price).toFixed(2)+'</span>':'')+'</div>'+(o.link?'<a href="'+esc(o.link)+'" target="_blank" rel="noopener noreferrer">View product ↗</a>':'<span class="link-pending">Link not saved yet</span>')+'</div>';
  }
  return out+'</div>';
}
function changePriority(x,dir){const levels=["Eventually","Want","Need"],i=levels.indexOf(x.priority),n=Math.max(0,Math.min(2,i+(dir==="up"?1:-1)));x.priority=levels[n];saveItem(x).catch(showErr);renderLists()}
function openEdit(x){$("dialogTitle").textContent="Edit item";$("itemId").value=x.id;$("item").value=x.item;$("category").value=x.category||"";$("priority").value=x.priority||"Need";$("quantity").value=x.quantity||"";$("itemStatus").value=x.status||"Looking";$("notes").value=x.notes||"";$("itemDialog").showModal()}
function openAddItem(){$("dialogTitle").textContent=currentPage==="buy"?"Add purchase":"Add grocery";$("itemId").value="";$("itemForm").reset();$("priority").value="Need";$("itemDialog").showModal()}

$("itemForm").addEventListener("submit",e=>{
  if(e.submitter?.value==="cancel")return;e.preventDefault();const id=$("itemId").value;let x=id?data[currentPage].find(v=>v.id===id):null;
  if(!x){x={id:crypto.randomUUID(),deleted:false,created:new Date().toISOString().slice(0,10)};data[currentPage].push(x)}
  Object.assign(x,{item:$("item").value.trim(),category:$("category").value.trim(),priority:$("priority").value,quantity:$("quantity").value.trim(),status:$("itemStatus").value,notes:$("notes").value.trim()});
  (id?saveItem(x):insertItem(x)).catch(showErr);$("itemDialog").close();renderLists();
});

async function loadDrivers(){
  const [{data:b,error:be},{data:d,error:de}]=await Promise.all([
    sb.from("bad_driver_baseline_counts").select("dimension,category,count").eq("source","historical baseline"),
    sb.from("bad_drivers").select("*").order("observed_at",{ascending:false})
  ]);
  if(!be&&b?.length)baseline=b;if(de){showErr(de,"driverStatus");drivers=[]}else drivers=d||[];
  renderDriverPage();
}
function dimensionCounts(dim){
  const map={};
  baseline.filter(x=>x.dimension===dim).forEach(x=>map[x.category]=(map[x.category]||0)+Number(x.count||0));
  const field={Race:"race",Gender:"gender",Age:"age_group",Obese:"obese"}[dim];
  drivers.forEach(x=>{const k=x[field]||"Unknown";map[k]=(map[k]||0)+1});
  return map;
}
function totalObservations(){return 26+drivers.length}
function chartData(dim){
  const preferred={Race:["White","Black","Asian","Other","Unknown"],Gender:["Woman","Man","Unknown"],Age:["14-25","25-39","40-59","60+","Unknown"],Obese:["Yes","No","Unknown"]}[dim];
  const counts=dimensionCounts(dim);return preferred.filter(k=>(counts[k]||0)>0).map(k=>({label:k,value:counts[k]||0}));
}
function makePie(id,dim){
  if(charts[id])charts[id].destroy();const rows=chartData(dim);
  charts[id]=new Chart($(id),{type:"pie",data:{labels:rows.map(x=>x.label),datasets:[{data:rows.map(x=>x.value)}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:"bottom"},tooltip:{callbacks:{label:c=>{const total=c.dataset.data.reduce((a,b)=>a+b,0);return ` ${c.label}: ${c.raw} (${(c.raw/total*100).toFixed(1)}%)`}}}}}});
}
function renderRatioChart(){
  const dim=$("ratioDimension").value,counts=dimensionCounts(dim),pop=IOWA[dim],labels=Object.keys(pop),total=totalObservations();
  const ratios=labels.map(k=>((counts[k]||0)/total*100)/pop[k]);
  if(charts.ratioChart)charts.ratioChart.destroy();
  charts.ratioChart=new Chart($("ratioChart"),{type:"bar",data:{labels,datasets:[{label:"Representation ratio",data:ratios},{type:"line",label:"Iowa proportional baseline",data:labels.map(()=>1),borderDash:[6,5],pointRadius:0,borderWidth:2}]},options:{responsive:true,maintainAspectRatio:false,scales:{y:{beginAtZero:true,title:{display:true,text:"Representation ratio (× Iowa share)"}}},plugins:{legend:{position:"bottom"},tooltip:{callbacks:{label:c=>c.dataset.type==="line"?" Iowa baseline: 1.00×":` ${c.dataset.label}: ${Number(c.raw).toFixed(2)}×`}}}}});
}
function wilson(k,n,z=1.96){if(!n)return[0,0];const p=k/n,d=1+z*z/n,mid=(p+z*z/(2*n))/d,half=z*Math.sqrt((p*(1-p)+z*z/(4*n))/n)/d;return[Math.max(0,mid-half),Math.min(1,mid+half)]}
function renderAnalysis(){
  const total=totalObservations(),dim=$("ratioDimension").value,counts=dimensionCounts(dim),pop=IOWA[dim];
  const rows=Object.keys(pop).map(k=>{const n=counts[k]||0,p=n/total*100,r=p/pop[k],[lo,hi]=wilson(n,total);return `<tr><td>${esc(k)}</td><td>${n}</td><td>${p.toFixed(1)}%</td><td>${pop[k].toFixed(1)}%</td><td><b>${r.toFixed(2)}×</b></td><td>${(lo*100).toFixed(1)}–${(hi*100).toFixed(1)}%</td></tr>`}).join("");
  $("analysisTable").innerHTML=`<div class="analysis-label">Showing: <b>${esc(dim==="Obese"?"Obesity":dim)}</b></div><div class="table-scroll"><table><thead><tr><th>Group</th><th>n</th><th>Your share</th><th>Iowa share</th><th>Ratio</th><th>95% CI for your share</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}
function renderDriverPage(){
  $("driverTotal").textContent=totalObservations();$("individualTotal").textContent=drivers.length;$("baselineTotal").textContent=26;
  if(driverView==="overview"){
    requestAnimationFrame(()=>{makePie("raceChart","Race");makePie("genderChart","Gender");makePie("ageChart","Age");makePie("obeseChart","Obese");renderRatioChart();renderAnalysis()});
  } else renderDriverList();
}
function renderDriverList(){
  const q=$("driverSearch").value.toLowerCase();let rows=drivers.filter(x=>!q||(x.description||"").toLowerCase().includes(q));
  const s=$("driverSort").value,ageRank={"14-25":0,"25-39":1,"40-59":2,"60+":3,Unknown:4};
  if(s==="newest")rows.sort((a,b)=>new Date(b.observed_at)-new Date(a.observed_at));
  if(s==="race")rows.sort((a,b)=>(a.race||"").localeCompare(b.race||""));
  if(s==="gender")rows.sort((a,b)=>(a.gender||"").localeCompare(b.gender||""));
  if(s==="age")rows.sort((a,b)=>(ageRank[a.age_group]??9)-(ageRank[b.age_group]??9));
  if(s==="obese")rows.sort((a,b)=>(a.obese||"").localeCompare(b.obese||""));
  $("driverList").innerHTML=rows.length?"":'<div class="card empty">No individual observations yet.</div>';
  rows.forEach(x=>{const el=document.createElement("button");el.className="driver-row";el.innerHTML=`<div class="driver-row-top"><b>${esc(x.race||"Unknown")} • ${esc(x.gender||"Unknown")}</b><span>${new Date(x.observed_at).toLocaleDateString()}</span></div><div class="driver-chips"><span>${esc(x.age_group||"Unknown")}</span><span>Obese: ${esc(x.obese||"Unknown")}</span></div><p>${esc((x.description||"").slice(0,120))}${(x.description||"").length>120?"…":""}</p>`;el.onclick=()=>openDriverDetail(x);$("driverList").appendChild(el)});
}
function openDriverDetail(x){
  $("driverDetail").innerHTML=`<div class="detail-grid"><div><span>Race</span><b>${esc(x.race||"Unknown")}</b></div><div><span>Gender</span><b>${esc(x.gender||"Unknown")}</b></div><div><span>Age</span><b>${esc(x.age_group||"Unknown")}</b></div><div><span>Obese?</span><b>${esc(x.obese||"Unknown")}</b></div></div><div class="detail-description"><span>Description</span><p>${esc(x.description||"No description")}</p></div><div class="detail-date">${new Date(x.observed_at).toLocaleString()}</div>`;
  $("driverDetailDialog").showModal();
}
async function addDriver(){
  const row={race:$("driverRace").value,gender:$("driverGender").value,age_group:$("driverAge").value,obese:$("driverObese").value,description:$("driverDescription").value.trim()};
  const {data:newRows,error}=await sb.from("bad_drivers").insert(row).select();if(error)throw error;
  if(newRows?.[0])drivers.unshift(newRows[0]);renderDriverPage();
}
$("driverForm").addEventListener("submit",e=>{if(e.submitter?.value==="cancel")return;e.preventDefault();addDriver().catch(e=>showErr(e,"driverStatus"));$("driverDialog").close();$("driverForm").reset()});
$("closeDriverDetail").onclick=()=>$("driverDetailDialog").close();

async function loadReminders(){
  const {data:r,error}=await sb.from("reminders").select("*").eq("completed",false).order("start_at",{ascending:true});
  if(error){showErr(error,"reminderStatus");reminders=[]}else reminders=r||[];
  renderReminders();
}
function localDay(d){return new Date(d.getFullYear(),d.getMonth(),d.getDate())}
function renderReminders(){
  const now=new Date(),today=localDay(now),tomorrow=new Date(today);tomorrow.setDate(today.getDate()+1);
  const afterTomorrow=new Date(tomorrow);afterTomorrow.setDate(tomorrow.getDate()+1);
  const weekEnd=new Date(today);weekEnd.setDate(today.getDate()+(7-today.getDay()));
  let start=today,end=tomorrow;
  if(reminderView==="tomorrow"){start=tomorrow;end=afterTomorrow}
  if(reminderView==="week"){start=today;end=weekEnd}
  const rows=reminders.filter(x=>{const d=new Date(x.start_at);return d>=start&&d<end});
  $("reminderList").innerHTML=rows.length?"":'<div class="card empty">Nothing scheduled here.</div>';
  rows.forEach(x=>{const d=new Date(x.start_at),el=document.createElement("article");el.className="reminder-card";
    const when=x.all_day?"All day":d.toLocaleTimeString([],{hour:"numeric",minute:"2-digit"});
    const day=reminderView==="week"?d.toLocaleDateString([],{weekday:"short",month:"short",day:"numeric"}):"";
    el.innerHTML=`<div class="reminder-date">${esc(day)}</div><div class="reminder-body"><b>${esc(x.title)}</b><span>${esc(when)}</span></div>${x.source==="google_calendar"?'<span class="calendar-badge">Calendar</span>':""}`;
    $("reminderList").appendChild(el);
  });
}
document.querySelectorAll(".reminder-tab").forEach(b=>b.onclick=()=>{reminderView=b.dataset.reminderView;document.querySelectorAll(".reminder-tab").forEach(z=>z.classList.toggle("active",z===b));renderReminders()});


const BUDGET_PIN_KEY="roggy-budget-pin-v1",BUDGET_CRED_KEY="roggy-budget-credential-v1";let budgetUnlocked=false,budgetTimer=null,budgetEntries=[],budgetMode="monthly";
function bytesToB64(b){return btoa(String.fromCharCode(...new Uint8Array(b)))} function b64ToBytes(s){return Uint8Array.from(atob(s),c=>c.charCodeAt(0))}
async function hashPin(pin,salt){const k=await crypto.subtle.importKey("raw",new TextEncoder().encode(pin),"PBKDF2",false,["deriveBits"]);return bytesToB64(await crypto.subtle.deriveBits({name:"PBKDF2",salt,iterations:210000,hash:"SHA-256"},k,256))}
function budgetConfigured(){return !!localStorage.getItem(BUDGET_PIN_KEY)} function touchBudget(){clearTimeout(budgetTimer);if(budgetUnlocked)budgetTimer=setTimeout(lockBudget,5*60*1000)}
async function unlockBudget(){budgetUnlocked=true;$("budgetLock").hidden=true;$("budgetContent").hidden=false;touchBudget();await loadBudgetData()}
function lockBudget(){budgetUnlocked=false;clearTimeout(budgetTimer);$("budgetContent").hidden=true;$("budgetLock").hidden=false;budgetEntries=[];$("budgetFlow").innerHTML="";$("budgetTableBody").innerHTML=""}
async function setupBudgetPin(pin){const salt=crypto.getRandomValues(new Uint8Array(16)),hash=await hashPin(pin,salt);localStorage.setItem(BUDGET_PIN_KEY,JSON.stringify({salt:bytesToB64(salt),hash}))}
async function verifyBudgetPin(pin){const r=JSON.parse(localStorage.getItem(BUDGET_PIN_KEY)||"null");return !!r&&(await hashPin(pin,b64ToBytes(r.salt)))===r.hash}
async function setupPasskey(){if(!window.PublicKeyCredential)throw new Error("Passkeys are not supported on this device.");const cred=await navigator.credentials.create({publicKey:{challenge:crypto.getRandomValues(new Uint8Array(32)),rp:{name:"Roggy Lists"},user:{id:crypto.getRandomValues(new Uint8Array(32)),name:"budget-owner",displayName:"Budget Owner"},pubKeyCredParams:[{alg:-7,type:"public-key"},{alg:-257,type:"public-key"}],authenticatorSelection:{authenticatorAttachment:"platform",userVerification:"required",residentKey:"preferred"},timeout:60000,attestation:"none"}});localStorage.setItem(BUDGET_CRED_KEY,bytesToB64(cred.rawId))}
async function faceUnlock(){const id=localStorage.getItem(BUDGET_CRED_KEY);if(!id){await setupPasskey();$("budgetLockStatus").textContent="Face ID / passkey enabled.";await unlockBudget();return}await navigator.credentials.get({publicKey:{challenge:crypto.getRandomValues(new Uint8Array(32)),allowCredentials:[{type:"public-key",id:b64ToBytes(id)}],userVerification:"required",timeout:60000}});await unlockBudget()}
function money(n){return new Intl.NumberFormat("en-US",{style:"currency",currency:"USD"}).format(Number(n||0))}
function normalizeBudgetAmount(x){let n=Number(x.amount||0);if(budgetMode==="paycheck"&&x.notes!=="per_paycheck")n=n*12/26;if(budgetMode==="monthly"&&x.notes==="per_paycheck")n=n*26/12;return n}
async function loadBudgetData(){const {data:{session}}=await sb.auth.getSession();if(!session){$("budgetDataStatus").textContent="Sign in is required before private budget records can sync.";renderBudget();return}const {data:rows,error}=await sb.from("budget_entries").select("*").order("entry_type");if(error){$("budgetDataStatus").textContent="Budget sync unavailable: "+error.message;budgetEntries=[]}else{$("budgetDataStatus").textContent="";budgetEntries=rows||[]}renderBudget()}
function renderBudget(){const income=budgetEntries.filter(x=>x.entry_type==="income").reduce((s,x)=>s+normalizeBudgetAmount(x),0),expense=budgetEntries.filter(x=>x.entry_type==="expense").reduce((s,x)=>s+normalizeBudgetAmount(x),0),goal=budgetEntries.filter(x=>x.entry_type==="goal").reduce((s,x)=>s+normalizeBudgetAmount(x),0),avail=income-expense-goal; $("budgetIncome").textContent=money(income);$("budgetSpending").textContent=money(expense);$("budgetAvailable").textContent=money(avail);renderBudgetTable();renderBudgetFlow()}
function renderBudgetTable(){const rows=budgetEntries.slice().sort((a,b)=>(a.category||"").localeCompare(b.category||"")||(a.name||"").localeCompare(b.name||""));$("budgetTableBody").innerHTML=rows.length?rows.map(x=>`<tr><td>${esc(x.category||x.entry_type)}</td><td>${esc(x.name)}</td><td>${esc(x.notes==="per_paycheck"?"Biweekly":"Monthly")}</td><td>${money(normalizeBudgetAmount(x))}</td></tr>`).join(""):'<tr><td colspan="4">No private budget rows synced yet.</td></tr>'}
function renderBudgetFlow(){const root=$("budgetFlow");root.innerHTML="";if(!budgetEntries.length){root.innerHTML='<div class="budget-empty">Private budget data will appear here after account sign-in.</div>';return}const income=budgetEntries.filter(x=>x.entry_type==="income"),outs=budgetEntries.filter(x=>x.entry_type!=="income");const total=income.reduce((s,x)=>s+normalizeBudgetAmount(x),0);const left=document.createElement("div");left.className="flow-source";left.innerHTML='<span>Income</span><b>'+money(total)+'</b>';root.appendChild(left);const lanes=document.createElement("div");lanes.className="flow-lanes";outs.forEach(x=>{const v=normalizeBudgetAmount(x),row=document.createElement("button");row.className="flow-row";row.innerHTML='<span class="flow-line" style="--w:'+Math.max(4,Math.min(100,total?v/total*100:0))+'%"></span><span class="flow-label">'+esc(x.name)+'</span><b>'+money(v)+'</b>';row.onclick=()=>{document.querySelectorAll(".flow-row").forEach(z=>z.classList.remove("active"));row.classList.add("active")};lanes.appendChild(row)});root.appendChild(lanes)}
$("budgetModeMonthly").onclick=()=>{budgetMode="monthly";$("budgetModeMonthly").classList.add("active");$("budgetModePaycheck").classList.remove("active");renderBudget()}
$("budgetModePaycheck").onclick=()=>{budgetMode="paycheck";$("budgetModePaycheck").classList.add("active");$("budgetModeMonthly").classList.remove("active");renderBudget()}
$("setupBudgetLockBtn").onclick=()=>$("budgetSetupDialog").showModal();$("pinUnlockBtn").onclick=()=>budgetConfigured()?$("budgetPinDialog").showModal():$("budgetSetupDialog").showModal();$("faceUnlockBtn").onclick=()=>faceUnlock().catch(e=>$("budgetLockStatus").textContent=e.message||"Face ID / passkey unlock failed.");$("lockBudgetBtn").onclick=lockBudget;
$("budgetSetupForm").addEventListener("submit",async e=>{if(e.submitter?.value==="cancel")return;e.preventDefault();const a=$("budgetPinNew").value,b=$("budgetPinConfirm").value;if(a!==b){$("budgetPinConfirm").setCustomValidity("PINs do not match");$("budgetPinConfirm").reportValidity();return}$("budgetPinConfirm").setCustomValidity("");await setupBudgetPin(a);$("budgetSetupDialog").close();$("budgetSetupForm").reset();try{await setupPasskey();$("budgetLockStatus").textContent="PIN and Face ID / passkey are ready."}catch{$("budgetLockStatus").textContent="PIN is ready. Face ID / passkey setup is still available."}});
$("budgetPinForm").addEventListener("submit",async e=>{if(e.submitter?.value==="cancel")return;e.preventDefault();if(await verifyBudgetPin($("budgetPinEntry").value)){$("budgetPinDialog").close();$("budgetPinForm").reset();$("budgetPinError").textContent="";await unlockBudget()}else $("budgetPinError").textContent="Incorrect PIN."});document.addEventListener("visibilitychange",()=>{if(document.hidden)lockBudget()});["pointerdown","keydown"].forEach(ev=>document.addEventListener(ev,()=>{if(currentPage==="budget")touchBudget()},{passive:true}));

function setPage(page){
  currentPage=page;document.querySelectorAll(".page-tab").forEach(b=>b.classList.toggle("active",b.dataset.page===page));
  const isDrivers=page==="drivers",isReminders=page==="reminders",isBudget=page==="budget";$("listsPage").hidden=isDrivers||isReminders||isBudget;$("driversPage").hidden=!isDrivers;$("remindersPage").hidden=!isReminders;$("budgetPage").hidden=!isBudget;$("backupBtn").style.display=(isDrivers||isReminders||isBudget)?"none":"";
  $("addBtn").style.display="";
  if(isDrivers){$("pageTitle").textContent="Bad Drivers";$("pageSubtitle").textContent="Track observations and compare demographics.";loadDrivers()}
  else if(isReminders){$("pageTitle").textContent="Reminders";$("pageSubtitle").textContent="What is coming up.";$("addBtn").style.display="none";loadReminders()} else if(isBudget){$("pageTitle").textContent="Budget 🔒";$("pageSubtitle").textContent="Private financial dashboard.";$("addBtn").style.display="none";lockBudget()}
  else {currentView="active";document.querySelectorAll(".sub-tab").forEach(z=>z.classList.toggle("active",z.dataset.view==="active"));renderLists()}
}
document.querySelectorAll(".page-tab").forEach(b=>b.onclick=()=>setPage(b.dataset.page));
document.querySelectorAll("#listsPage .sub-tab").forEach(b=>b.onclick=()=>{currentView=b.dataset.view;document.querySelectorAll("#listsPage .sub-tab").forEach(z=>z.classList.toggle("active",z===b));renderLists()});
document.querySelectorAll(".driver-tab").forEach(b=>b.onclick=()=>{driverView=b.dataset.driverView;document.querySelectorAll(".driver-tab").forEach(z=>z.classList.toggle("active",z===b));$("driverOverview").hidden=driverView!=="overview";$("driverObservations").hidden=driverView!=="observations";renderDriverPage()});
document.querySelectorAll(".filter").forEach(b=>b.onclick=()=>{currentFilter=b.dataset.filter;document.querySelectorAll(".filter").forEach(z=>z.classList.toggle("active",z===b));renderLists()});
$("search").oninput=renderLists;$("sort").onchange=renderLists;
$("driverSearch").oninput=renderDriverList;$("driverSort").onchange=renderDriverList;
$("ratioDimension").onchange=()=>{renderRatioChart();renderAnalysis()};
$("addBtn").onclick=()=>currentPage==="drivers"?$("driverDialog").showModal():openAddItem();

$("backupBtn").onclick=()=>{const blob=new Blob([JSON.stringify(data,null,2)],{type:"application/json"}),a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download="roggy-lists-backup.json";a.click();URL.revokeObjectURL(a.href)};

function applyAuthSession(session){$("authBtn").textContent=session?"Sign out":"Sign in";$("authBtn").title=session?.user?.email||"Sign in with GitHub"}
async function finishOAuthRedirect(){const p=new URLSearchParams(location.search),code=p.get("code"),err=p.get("error_description")||p.get("error");if(err){$("status").textContent="Sign-in error: "+err;history.replaceState({},document.title,location.pathname);return}if(!code)return;const {data,error}=await sb.auth.exchangeCodeForSession(code);history.replaceState({},document.title,location.pathname);if(error){$("status").textContent="Sign-in error: "+error.message;applyAuthSession(null);return}applyAuthSession(data.session);$("status").textContent=""}
async function updateAuth(){const {data:{session},error}=await sb.auth.getSession();if(error)showErr(error);applyAuthSession(session);return session}
$("authBtn").onclick=async()=>{const session=await updateAuth();if(session){const {error}=await sb.auth.signOut({scope:"local"});if(error)showErr(error);else applyAuthSession(null)}else{const {error}=await sb.auth.signInWithOAuth({provider:"github",options:{redirectTo:"https://garoggy.github.io/roggy-buy-list/"}});if(error)showErr(error)}};
sb.auth.onAuthStateChange((event,session)=>{applyAuthSession(session);setTimeout(()=>{loadLists();if(currentPage==="drivers")loadDrivers();if(currentPage==="reminders")loadReminders();if(currentPage==="budget"&&budgetUnlocked)loadBudgetData()},0)});

if("serviceWorker"in navigator)navigator.serviceWorker.register("sw.js");
finishOAuthRedirect().then(()=>updateAuth());loadLists();
