// After deploying Code.gs as a Google Apps Script Web App,
// paste its /exec URL below.
const API_URL = "https://script.google.com/macros/s/AKfycby-S8CLT9WCg95lgUVmPliMTvhSty0mF7xQJLT8FOt1GyOJiCgiwiTtgUaqRDipMgCtdQ/exec";

let items = [];
let currentFilter = "all";

const list = document.getElementById("list");
const statusEl = document.getElementById("status");
const dialog = document.getElementById("itemDialog");

function money(v){ if(!v) return ""; const n=Number(String(v).replace(/[$,]/g,"")); return Number.isFinite(n) ? `$${n.toFixed(n%1?2:0)}` : v; }

async function api(action, payload={}){
  if(API_URL.includes("PASTE_YOUR")){
    throw new Error("Connect the app to Google Sheets first. See SETUP.txt.");
  }
  const r = await fetch(API_URL,{
    method:"POST",
    headers:{"Content-Type":"text/plain;charset=utf-8"},
    body:JSON.stringify({action,...payload})
  });
  const data = await r.json();
  if(!data.ok) throw new Error(data.error || "Request failed");
  return data;
}

async function load(){
  statusEl.textContent="Loading…";
  try{
    const data = await api("list");
    items = data.items || [];
    statusEl.textContent="";
    render();
  }catch(e){
    statusEl.textContent=e.message;
    render();
  }
}

function render(){
  const q=document.getElementById("search").value.trim().toLowerCase();
  const priorityRank={Need:0,Want:1,Eventually:2};
  const shown=items.filter(x=>(currentFilter==="all"||x.priority===currentFilter) &&
    (!q || [x.item,x.category,x.notes].join(" ").toLowerCase().includes(q)))
    .sort((a,b)=>(priorityRank[a.priority]??9)-(priorityRank[b.priority]??9) || a.row-b.row);

  list.innerHTML="";
  if(!shown.length){
    list.innerHTML='<div class="card">Nothing here yet.</div>';
    return;
  }
  for(const x of shown){
    const c=document.createElement("article");
    c.className="card "+(x.status==="Bought"?"bought":"");
    c.innerHTML=`
      <div class="card-top">
        <div class="item-name">${esc(x.item)}</div>
        <span class="badge ${esc(x.priority)}">${esc(x.priority)}</span>
      </div>
      <div class="meta">
        <span>${esc(x.category||"Other")}</span>
        ${x.targetPrice?`<span>Target ${esc(money(x.targetPrice))}</span>`:""}
        <span>${esc(x.status||"Looking")}</span>
      </div>
      ${x.notes?`<div class="meta">${esc(x.notes)}</div>`:""}
      <div class="options">
        ${optionHtml(x.option1,x.price1,x.link1)}
        ${optionHtml(x.option2,x.price2,x.link2)}
        ${optionHtml(x.option3,x.price3,x.link3)}
      </div>`;
    c.onclick=()=>openEdit(x);
    list.appendChild(c);
  }
}

function optionHtml(name,price,link){
  if(!name&&!price&&!link) return "";
  return `<div class="option"><span>${esc(name||"Option")} ${price?`— ${esc(money(price))}`:""}</span>${link?`<a href="${attr(link)}" target="_blank" onclick="event.stopPropagation()">Open</a>`:""}</div>`;
}
function esc(s=""){return String(s).replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[m]))}
function attr(s=""){return String(s).replace(/"/g,"&quot;")}

document.querySelectorAll(".filter").forEach(b=>b.onclick=()=>{
  document.querySelectorAll(".filter").forEach(x=>x.classList.remove("active"));
  b.classList.add("active"); currentFilter=b.dataset.filter; render();
});
document.getElementById("search").oninput=render;
document.getElementById("refreshBtn").onclick=load;
document.getElementById("addBtn").onclick=()=>openAdd();

function openAdd(){
  document.getElementById("dialogTitle").textContent="Add item";
  document.getElementById("rowIndex").value="";
  document.getElementById("itemForm").reset();
  dialog.showModal();
}
function openEdit(x){
  document.getElementById("dialogTitle").textContent="Edit item";
  rowIndex.value=x.row; item.value=x.item; category.value=x.category||"Other";
  priority.value=x.priority||"Want"; targetPrice.value=x.targetPrice||"";
  itemStatus.value=x.status||"Looking"; notes.value=x.notes||"";
  dialog.showModal();
}
document.getElementById("itemForm").addEventListener("submit",async e=>{
  if(e.submitter?.value==="cancel") return;
  e.preventDefault();
  const payload={
    row:Number(rowIndex.value)||null,
    item:item.value.trim(),
    category:category.value,
    priority:priority.value,
    targetPrice:targetPrice.value.trim(),
    status:itemStatus.value,
    notes:notes.value.trim()
  };
  try{
    document.getElementById("saveBtn").disabled=true;
    await api(payload.row?"update":"add",payload);
    dialog.close(); await load();
  }catch(err){ alert(err.message); }
  finally{document.getElementById("saveBtn").disabled=false;}
});

if("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js");
load();
