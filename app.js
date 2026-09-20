const SUPABASE_URL="https://dplvxsniyqkwlmdzqbyg.supabase.co";
const SUPABASE_KEY="sb_publishable_4WYS4v4U7PSgXesYNNJUfA_69lJaBX1";
const KEY="roggy-lists-v1";
const sb=window.supabase.createClient(SUPABASE_URL,SUPABASE_KEY,{auth:{flowType:"pkce",detectSessionInUrl:true,persistSession:true,autoRefreshToken:true}});
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
let digestibles=[],digestView="books",digestStatusView="queue";

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
function budgetGroup(x){const n=(x.name||"").toLowerCase(),cat=(x.category||"").toLowerCase();if(x.entry_type==="goal"||n.includes("roth")||n.includes("401"))return "Savings";if(n.includes("toyota")||n.includes("geico")||cat.includes("transport")||cat.includes("auto")||cat.includes("insurance"))return "Auto";if(n.includes("chatgpt")||cat.includes("subscription"))return "Subscriptions";if(n.includes("rent")||n.includes("utility")||n.includes("internet")||n.includes("mediacom")||n.includes("gym")||cat.includes("housing")||cat.includes("utilities"))return "Living";return "Other"}
function budgetModel(){const income=budgetEntries.filter(x=>x.entry_type==="income").reduce((s,x)=>s+normalizeBudgetAmount(x),0),items=budgetEntries.filter(x=>x.entry_type!=="income").map(x=>({...x,_value:normalizeBudgetAmount(x),_group:budgetGroup(x)})).filter(x=>x._value>0),allocated=items.reduce((s,x)=>s+x._value,0),left=Math.max(0,income-allocated);return{income,items,allocated,left}}
function renderBudget(){const m=budgetModel();$("budgetIncome").textContent=money(m.income);$("budgetSpending").textContent=money(m.allocated);$("budgetAvailable").textContent=money(m.left);renderBudgetTable();renderBudgetFlow()}
function renderBudgetTable(){const m=budgetModel(),order=["Savings","Living","Auto","Subscriptions","Other"];const rows=m.items.sort((a,b)=>order.indexOf(a._group)-order.indexOf(b._group)||b._value-a._value);$("budgetTableBody").innerHTML=rows.length?rows.map(x=>`<tr><td><span class="budget-cat cat-${x._group.toLowerCase()}">${esc(x._group)}</span></td><td>${esc(x.name)}</td><td>${money(x._value)}</td><td>${m.income?(x._value/m.income*100).toFixed(1):"0.0"}%</td></tr>`).join(""):'<tr><td colspan="4">No private budget rows synced yet.</td></tr>'}
function renderBudgetFlow(){
 const root=$("budgetFlow");root.innerHTML="";const m=budgetModel();
 if(!m.income){root.innerHTML='<div class="budget-empty">Add an income baseline to build the Sankey diagram.</div>';return}
 if(!window.d3||!d3.sankey){root.innerHTML='<div class="budget-empty">Sankey library failed to load. Refresh the app.</div>';return}
 const order=["Savings","Living","Auto","Subscriptions","Other"];
 const groups=order.map(name=>({name,items:m.items.filter(x=>x._group===name)})).filter(g=>g.items.length);
 groups.forEach(g=>g.value=g.items.reduce((s,x)=>s+x._value,0));
 const nodes=[{id:"income",name:"Total Income",type:"source",value:m.income}];
 const links=[];
 groups.forEach(g=>{const gid="group:"+g.name;nodes.push({id:gid,name:g.name,type:"group",group:g.name,value:g.value});links.push({source:"income",target:gid,value:g.value,group:g.name});g.items.forEach((x,i)=>{const id=gid+":item:"+i;nodes.push({id,name:x.name,type:"item",group:g.name,value:x._value});links.push({source:gid,target:id,value:x._value,group:g.name})})});
 if(m.left>0){nodes.push({id:"leftover",name:"Left Over",type:"group",group:"Left Over",value:m.left});links.push({source:"income",target:"leftover",value:m.left,group:"Left Over"})}
 const W=1080,H=Math.max(680,560+Math.max(0,m.items.length-8)*34),left=180,right=785,top=24,bottom=24;
 const sankey=d3.sankey().nodeId(d=>d.id).nodeWidth(12).nodePadding(34).nodeAlign(d3.sankeyJustify).nodeSort((a,b)=>{const rank={"Savings":0,"Living":1,"Auto":2,"Subscriptions":3,"Other":4,"Left Over":5};const ag=a.type==="group"?rank[a.name]:(rank[a.group]??99),bg=b.type==="group"?rank[b.name]:(rank[b.group]??99);return ag-bg}).extent([[left,top],[right,H-bottom]]);
 const graph=sankey({nodes:nodes.map(d=>({...d})),links:links.map(d=>({...d}))});
 const svg=d3.create("svg").attr("viewBox",[0,0,W,H]).attr("class","sankey-svg sankey-d3").attr("role","img").attr("aria-label","Monthly income flowing through budget categories to individual allocations.");
 const colors={"Savings":"#22a06b","Living":"#3b82f6","Auto":"#f59e42","Subscriptions":"#9b5de5","Other":"#9ca3af","Left Over":"#ef6464"};
 svg.append("g").selectAll("path").data(graph.links).join("path").attr("d",d3.sankeyLinkHorizontal()).attr("fill","none").attr("stroke",d=>colors[d.group]||"#94a3b8").attr("stroke-opacity",.30).attr("stroke-width",d=>Math.max(1,d.width));
 const source=graph.nodes.find(n=>n.id==="income");
 svg.append("rect").attr("x",20).attr("y",source.y0).attr("width",150).attr("height",source.y1-source.y0).attr("rx",8).attr("fill","#1f2937");
 const sy=(source.y0+source.y1)/2;svg.append("text").attr("x",40).attr("y",sy-18).attr("class","sk-source-label").text("Total Income");svg.append("text").attr("x",40).attr("y",sy+12).attr("class","sk-source-value").text(money(m.income));svg.append("text").attr("x",40).attr("y",sy+34).attr("class","sk-source-sub").text(budgetMode==="monthly"?"monthly":"per paycheck");
 const nonSource=graph.nodes.filter(n=>n.id!=="income");
 svg.append("g").selectAll("rect").data(nonSource).join("rect").attr("x",d=>d.x0).attr("y",d=>d.y0).attr("width",d=>d.x1-d.x0).attr("height",d=>Math.max(2,d.y1-d.y0)).attr("rx",3).attr("fill",d=>colors[d.group]||"#94a3b8");
 const groupsOnly=graph.nodes.filter(n=>n.type==="group");
 const gl=svg.append("g");
 groupsOnly.forEach(d=>{const y=(d.y0+d.y1)/2,h=d.y1-d.y0,labelY=h<38?d.y0-9:y-3,valueY=h<38?d.y0+10:y+15;gl.append("text").attr("x",d.x1+12).attr("y",labelY).attr("class","sk-mid-label").text(d.name);gl.append("text").attr("x",d.x1+12).attr("y",valueY).attr("class","sk-mid-value").text(money(d.value)+" · "+(d.value/m.income*100).toFixed(1)+"%")});
 const items=graph.nodes.filter(n=>n.type==="item");
 const cards=svg.append("g");
 items.forEach(d=>{const cy=(d.y0+d.y1)/2,bh=Math.max(32,d.y1-d.y0),y=cy-bh/2,x=d.x1+12,w=270;cards.append("rect").attr("x",x).attr("y",y).attr("width",w).attr("height",bh).attr("rx",6).attr("class","sk-item");cards.append("rect").attr("x",x).attr("y",y).attr("width",7).attr("height",bh).attr("rx",3).attr("fill",colors[d.group]||"#94a3b8");cards.append("text").attr("x",x+18).attr("y",cy+4).attr("class","sk-item-label").text(d.name);cards.append("text").attr("x",x+w-12).attr("y",cy+4).attr("class","sk-item-value").text(money(d.value))});
 root.appendChild(svg.node())
}
$("budgetModeMonthly").onclick=()=>{budgetMode="monthly";$("budgetModeMonthly").classList.add("active");$("budgetModePaycheck").classList.remove("active");renderBudget()}
$("budgetModePaycheck").onclick=()=>{budgetMode="paycheck";$("budgetModePaycheck").classList.add("active");$("budgetModeMonthly").classList.remove("active");renderBudget()}
$("setupBudgetLockBtn").onclick=()=>$("budgetSetupDialog").showModal();$("pinUnlockBtn").onclick=()=>budgetConfigured()?$("budgetPinDialog").showModal():$("budgetSetupDialog").showModal();$("faceUnlockBtn").onclick=()=>faceUnlock().catch(e=>$("budgetLockStatus").textContent=e.message||"Face ID / passkey unlock failed.");$("lockBudgetBtn").onclick=lockBudget;
$("budgetSetupForm").addEventListener("submit",async e=>{if(e.submitter?.value==="cancel")return;e.preventDefault();const a=$("budgetPinNew").value,b=$("budgetPinConfirm").value;if(a!==b){$("budgetPinConfirm").setCustomValidity("PINs do not match");$("budgetPinConfirm").reportValidity();return}$("budgetPinConfirm").setCustomValidity("");await setupBudgetPin(a);$("budgetSetupDialog").close();$("budgetSetupForm").reset();try{await setupPasskey();$("budgetLockStatus").textContent="PIN and Face ID / passkey are ready."}catch{$("budgetLockStatus").textContent="PIN is ready. Face ID / passkey setup is still available."}});
$("budgetPinForm").addEventListener("submit",async e=>{if(e.submitter?.value==="cancel")return;e.preventDefault();if(await verifyBudgetPin($("budgetPinEntry").value)){$("budgetPinDialog").close();$("budgetPinForm").reset();$("budgetPinError").textContent="";await unlockBudget()}else $("budgetPinError").textContent="Incorrect PIN."});document.addEventListener("visibilitychange",()=>{if(document.hidden)lockBudget()});["pointerdown","keydown"].forEach(ev=>document.addEventListener(ev,()=>{if(currentPage==="budget")touchBudget()},{passive:true}));


async function loadDigestibles(){
 const {data:r,error}=await sb.from("digestibles").select("*").order("created_at",{ascending:true});
 if(error){showErr(error,"digestStatus");digestibles=[]}else digestibles=r||[];
 renderDigestibles();
}
function updateDigestStatusLabels(){document.querySelectorAll(".digest-status-tab").forEach(b=>{const completed=b.dataset.digestStatus==="completed";b.textContent=digestView==="books"?(completed?"Books I’ve Read":"Books to Read"):(completed?"Movies I’ve Watched":"Movies to Watch")})}
function renderDigestibles(){
 updateDigestStatusLabels();
 const type=digestView==="books"?"book":"movie",rows=digestibles.filter(x=>x.media_type===type&&x.status===digestStatusView);
 $("digestItems").innerHTML='<div class="digest-list">'+(rows.length?"":'<div class="card empty">Nothing here yet.</div>')+'</div>';
 const root=$("digestItems").querySelector(".digest-list");rows.forEach(x=>root.appendChild(digestCard(x)));
}
function digestCard(x){
 const el=document.createElement("button");el.className="digest-card";
 const rating=x.rating!=null?'<span class="digest-rating">'+esc(x.rating)+"/"+esc(x.rating_scale||5)+'</span>':"";
 el.innerHTML='<div><b>'+esc(x.title)+'</b><span>'+(x.media_type==="book"?"by ":"Directed by ")+esc(x.creator||"Unknown")+'</span></div>'+rating+'<span class="chevron">⌄</span>';
 el.onclick=()=>openDigestDetail(x);return el;
}
function digestLink(url,label){return url?'<a class="digest-link" href="'+esc(url)+'" target="_blank" rel="noopener">'+esc(label)+'</a>':""}
function openDigestDetail(x){
 $("digestDetailTitle").textContent=x.title;
 let html='<div class="digest-creator">'+(x.media_type==="book"?"Author":"Director")+': <b>'+esc(x.creator||"Unknown")+'</b></div>';
 if(x.rating!=null)html+='<div class="digest-big-rating">'+esc(x.rating)+' / '+esc(x.rating_scale||5)+'</div>';
 if(x.description)html+='<div class="digest-description">'+esc(x.description)+'</div>';
 if(x.review)html+='<div class="digest-review">'+esc(x.review)+'</div>';
 if(x.media_type==="book"){
   html+='<div class="digest-links">'+digestLink(x.amazon_url,"Amazon");
   if(x.free_audio_url)html+=digestLink(x.free_audio_url,"Free audiobook");
   if(x.spotify_url&&x.spotify_url!==x.free_audio_url)html+=digestLink(x.spotify_url,"Spotify");
   if(x.youtube_url&&x.youtube_url!==x.free_audio_url)html+=digestLink(x.youtube_url,"YouTube");
   html+='</div>';
 } else {
   html+='<div class="movie-facts"><div><span>Streaming</span><b>'+esc(x.streaming_service||"Not currently listed")+'</b></div><div class="rt-direct"><span>Rotten Tomatoes</span><b>'+((x.rotten_tomatoes_critics!=null)?x.rotten_tomatoes_critics+"% Critics":"—")+'</b><small>'+((x.rotten_tomatoes_audience!=null)?x.rotten_tomatoes_audience+"% Audience":"")+'</small></div></div>';
 }
 $("digestDetail").innerHTML=html;$("digestDetailDialog").showModal();
}
document.querySelectorAll(".digest-tab").forEach(b=>b.onclick=()=>{digestView=b.dataset.digestView;digestStatusView="queue";document.querySelectorAll(".digest-tab").forEach(z=>z.classList.toggle("active",z===b));document.querySelectorAll(".digest-status-tab").forEach(z=>z.classList.toggle("active",z.dataset.digestStatus==="queue"));renderDigestibles()});
document.querySelectorAll(".digest-status-tab").forEach(b=>b.onclick=()=>{digestStatusView=b.dataset.digestStatus;document.querySelectorAll(".digest-status-tab").forEach(z=>z.classList.toggle("active",z===b));renderDigestibles()});
$("closeDigestDetail").onclick=()=>$("digestDetailDialog").close();

function setPage(page){
  currentPage=page;document.querySelectorAll(".page-tab").forEach(b=>b.classList.toggle("active",b.dataset.page===page));
  const isDrivers=page==="drivers",isReminders=page==="reminders",isBudget=page==="budget",isDigest=page==="digestibles";$("listsPage").hidden=isDrivers||isReminders||isBudget||isDigest;$("driversPage").hidden=!isDrivers;$("remindersPage").hidden=!isReminders;$("budgetPage").hidden=!isBudget;$("digestiblesPage").hidden=!isDigest;$("backupBtn").style.display=(isDrivers||isReminders||isBudget||isDigest)?"none":"";
  $("addBtn").style.display="";
  if(isDrivers){$("pageTitle").textContent="Bad Drivers";$("pageSubtitle").textContent="Track observations and compare demographics.";loadDrivers()}
  else if(isReminders){$("pageTitle").textContent="Reminders";$("pageSubtitle").textContent="What is coming up.";$("addBtn").style.display="none";loadReminders()} else if(isDigest){$("pageTitle").textContent="Digestibles";$("pageSubtitle").textContent="Books and movies worth consuming.";$("addBtn").style.display="none";loadDigestibles()} else if(isBudget){$("pageTitle").textContent="Budget 🔒";$("pageSubtitle").textContent="Private financial dashboard.";$("addBtn").style.display="none";lockBudget()}
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
$("authBtn").onclick=async()=>{const {data:{session}}=await sb.auth.getSession();if(session){const {error}=await sb.auth.signOut({scope:"local"});if(error)showErr(error);else applyAuthSession(null);return}const {data,error}=await sb.auth.signInWithOAuth({provider:"github",options:{redirectTo:"https://garoggy.github.io/roggy-buy-list/",skipBrowserRedirect:true}});if(error){showErr(error);return}if(data?.url)window.location.assign(data.url);else $("status").textContent="Sign-in error: Supabase did not return an authorization URL."};
sb.auth.onAuthStateChange((event,session)=>{applyAuthSession(session);setTimeout(()=>{loadLists();if(currentPage==="drivers")loadDrivers();if(currentPage==="reminders")loadReminders();if(currentPage==="budget"&&budgetUnlocked)loadBudgetData();if(currentPage==="digestibles")loadDigestibles()},0)});


/* Appearance settings v31 */
const THEME_KEY="roggy-theme",UI_SIZE_KEY="roggy-ui-size";
function applyAppearance(){
 const theme=localStorage.getItem(THEME_KEY)||"purple",size=localStorage.getItem(UI_SIZE_KEY)||"medium";
 document.documentElement.dataset.theme=theme;document.documentElement.dataset.uiSize=size;
 document.querySelectorAll(".color-choice").forEach(b=>b.classList.toggle("active",b.dataset.theme===theme));
 document.querySelectorAll(".size-choice").forEach(b=>b.classList.toggle("active",b.dataset.size===size));
 const swatch=document.querySelector('.color-choice[data-theme="'+theme+'"]');if(swatch){const color=swatch.style.getPropertyValue("--swatch");document.querySelector('meta[name="theme-color"]')?.setAttribute("content",color)}
}
applyAppearance();
document.querySelectorAll(".color-choice").forEach(b=>b.onclick=()=>{localStorage.setItem(THEME_KEY,b.dataset.theme);applyAppearance()});
document.querySelectorAll(".size-choice").forEach(b=>b.onclick=()=>{localStorage.setItem(UI_SIZE_KEY,b.dataset.size);applyAppearance()});
$("settingsShelfBtn").onclick=()=>{$("moreToggle").checked=false;$("settingsToggle").checked=true};

if("serviceWorker"in navigator)navigator.serviceWorker.register("sw.js");
updateAuth();loadLists();
