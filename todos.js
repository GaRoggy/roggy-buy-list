let todos=[],todoFilter="open";

async function loadTodos(){
  const {data,error}=await sb.from("todos").select("*").order("status",{ascending:true}).order("priority",{ascending:true}).order("created_at",{ascending:false});
  if(error){$("todoStatus").textContent="Sync error: "+error.message;todos=[];renderTodos();return}
  todos=data||[];$("todoStatus").textContent="";renderTodos();
}
function todoPriorityRank(p){return p==="high"?0:p==="medium"?1:2}
function todoDueLabel(x){
  if(!x.due_date)return "";
  const d=new Date(x.due_date+"T00:00:00"),today=new Date();today.setHours(0,0,0,0);
  const tomorrow=new Date(today);tomorrow.setDate(today.getDate()+1);
  const cls=d<today?" overdue":d.getTime()===today.getTime()?" today":"";
  const txt=d<today?"Overdue":d.getTime()===today.getTime()?"Today":d.getTime()===tomorrow.getTime()?"Tomorrow":d.toLocaleDateString([],{month:"short",day:"numeric"});
  return '<span class="todo-due'+cls+'">'+esc(txt)+'</span>';
}
function renderTodos(){
  if(!$("todoList"))return;
  let rows=[...todos];
  if(todoFilter==="open")rows=rows.filter(x=>x.status==="open");
  else if(todoFilter==="done")rows=rows.filter(x=>x.status==="done");
  else if(todoFilter==="high")rows=rows.filter(x=>x.status==="open"&&x.priority==="high");
  rows.sort((a,b)=>(a.status==="done")-(b.status==="done")||todoPriorityRank(a.priority)-todoPriorityRank(b.priority)||String(a.due_date||"9999").localeCompare(String(b.due_date||"9999")));
  $("todoList").innerHTML=rows.length?rows.map(x=>{
    const email=x.email_url?'<a class="todo-email" href="'+esc(x.email_url)+'" target="_blank" rel="noopener noreferrer" title="'+esc(x.email_subject||"Open email")+'">✉ Email</a>':"";
    const notes=x.notes?'<p class="todo-notes">'+esc(x.notes)+'</p>':"";
    return '<article class="todo-card '+(x.status==="done"?"todo-done":"")+'" data-todo-id="'+esc(x.id)+'"><button class="todo-check" data-todo-toggle="'+esc(x.id)+'" aria-label="'+(x.status==="done"?"Mark open":"Mark complete")+'">'+(x.status==="done"?"✓":"")+'</button><div class="todo-body"><div class="todo-title-row"><h3>'+esc(x.title)+'</h3><span class="todo-priority '+esc(x.priority)+'">'+esc(x.priority)+'</span></div><div class="todo-meta">'+(x.category?'<span>'+esc(x.category)+'</span>':"")+todoDueLabel(x)+email+'</div>'+notes+'</div><button class="todo-delete" data-todo-delete="'+esc(x.id)+'" aria-label="Delete task">×</button></article>';
  }).join(""):'<div class="system-card empty-project"><b>Nothing here.</b><p>Either you are terrifyingly efficient or this filter is empty.</p></div>';
  document.querySelectorAll("[data-todo-toggle]").forEach(b=>b.onclick=()=>toggleTodo(b.dataset.todoToggle));
  document.querySelectorAll("[data-todo-delete]").forEach(b=>b.onclick=()=>deleteTodo(b.dataset.todoDelete));
}
async function toggleTodo(id){
  const x=todos.find(t=>t.id===id);if(!x)return;
  const done=x.status!=="done",patch={status:done?"done":"open",completed_at:done?new Date().toISOString():null,updated_at:new Date().toISOString()};
  const {error}=await sb.from("todos").update(patch).eq("id",id);if(error){$("todoStatus").textContent=error.message;return}
  Object.assign(x,patch);renderTodos();
}
async function deleteTodo(id){
  const {error}=await sb.from("todos").delete().eq("id",id);if(error){$("todoStatus").textContent=error.message;return}
  todos=todos.filter(x=>x.id!==id);renderTodos();
}
document.querySelectorAll(".todo-filter").forEach(b=>b.onclick=()=>{todoFilter=b.dataset.todoFilter;document.querySelectorAll(".todo-filter").forEach(z=>z.classList.toggle("active",z===b));renderTodos()});
$("newTodoBtn").onclick=()=>$("todoDialog").showModal();
$("todoForm").addEventListener("submit",async e=>{
  if(e.submitter?.value==="cancel")return;
  e.preventDefault();
  const row={title:$("todoTitle").value.trim(),priority:$("todoPriority").value,category:$("todoCategory").value.trim()||null,due_date:$("todoDueDate").value||null,notes:$("todoNotes").value.trim()||null,email_url:$("todoEmailUrl").value.trim()||null};
  const {data,error}=await sb.from("todos").insert(row).select().single();
  if(error){$("todoStatus").textContent=error.message;return}
  todos.unshift(data);$("todoForm").reset();$("todoDialog").close();renderTodos();
});
