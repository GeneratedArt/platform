var u=new Set,f=10,g=!1,d=null;function v(e){g||(g=!0,d=e,window.addEventListener("error",t=>{let n=t.error&&t.error.message||t.message||"unknown_error",r=t.error&&t.error.stack||`${t.filename??""}:${t.lineno??0}:${t.colno??0}`;h(n,r)}),window.addEventListener("unhandledrejection",t=>{let n=t.reason,r=n instanceof Error?n.message:typeof n=="string"?n:"unhandled_rejection",a=n instanceof Error?n.stack??"":"";h(r,a)}))}function E(e){try{let t=new URL(e,location.origin);return`${t.origin}${t.pathname}`.slice(0,200)}catch{return e.split("?")[0].split("#")[0].slice(0,200)}}async function h(e,t){if(!d||u.size>=f)return;let n=`${e}::${t.slice(0,80)}`;if(!u.has(n)){u.add(n);try{await fetch(`${d.apiBase}/v1/internal/client-error`,{method:"POST",credentials:"include",headers:{"Content-Type":"application/json"},body:JSON.stringify({message:String(e).slice(0,500),stack:String(t).slice(0,4e3),page:d.page,url:E(location.href),ts:Date.now()}),keepalive:!0})}catch{}}}var y={draft:"Draft",published:"Published",minted:"Minted",archived:"Archived"};function w(e){return`<span class="${`ga-badge ga-badge-${e}`}">${y[e]||e}</span>`}function s(e){return e.replace(/[&<>"']/g,t=>{switch(t){case"&":return"&amp;";case"<":return"&lt;";case">":return"&gt;";case'"':return"&quot;";default:return"&#39;"}})}function C(e){let t=e.status==="archived",n=e.repo_url?`<a href="${s(e.repo_url)}" target="_blank" rel="noopener" class="ga-card-link">View repo \u2192</a>`:"",r=t?"":`<button class="btn btn-link p-0 text-danger ga-archive-btn" data-project-id="${e.id}">Archive</button>`;return`
    <article class="ga-project-card" data-project-id="${e.id}">
      <header>
        <h3 class="h5 mb-1">${s(e.title)}</h3>
        <p class="small text-muted mb-2">${s(e.engine)} \xB7 ${s(e.license)}</p>
      </header>
      <p class="small mb-3">${s(e.description||"No description yet.")}</p>
      <footer class="d-flex justify-content-between align-items-center">
        <div>${w(e.status)}</div>
        <div class="d-flex gap-3 align-items-center">
          ${n}
          ${r}
        </div>
      </footer>
    </article>
  `}function j(){return`
    <div class="ga-empty p-6 text-center">
      <h3 class="h5 mb-2">No projects yet.</h3>
      <p class="small text-muted mb-0">Click "New project" to create your first generative-art repo.</p>
    </div>
  `}function S(){return`
    <div class="modal fade" id="ga-new-project-modal" tabindex="-1" aria-hidden="true">
      <div class="modal-dialog modal-dialog-centered">
        <div class="modal-content rounded-0">
          <div class="modal-header">
            <h5 class="modal-title">New project</h5>
            <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
          </div>
          <form id="ga-new-project-form">
            <div class="modal-body">
              <div id="ga-new-project-error" class="alert alert-danger d-none small" role="alert"></div>
              <div class="mb-3">
                <label for="ga-np-title" class="form-label small">Title</label>
                <input type="text" required maxlength="80" class="form-control rounded-0" id="ga-np-title" />
              </div>
              <div class="mb-3">
                <label for="ga-np-description" class="form-label small">Short description</label>
                <textarea class="form-control rounded-0" id="ga-np-description" maxlength="500" rows="3"></textarea>
              </div>
              <div class="row">
                <div class="col-6 mb-3">
                  <label for="ga-np-engine" class="form-label small">Engine</label>
                  <select class="form-select rounded-0" id="ga-np-engine">
                    <option value="p5" selected>p5.js</option>
                    <option value="three">three.js</option>
                    <option value="shader">GLSL shader</option>
                    <option value="canvas">canvas / vanilla</option>
                  </select>
                </div>
                <div class="col-6 mb-3">
                  <label for="ga-np-license" class="form-label small">License</label>
                  <select class="form-select rounded-0" id="ga-np-license">
                    <option value="CC-BY-NC-4.0" selected>CC BY-NC 4.0</option>
                    <option value="CC-BY-4.0">CC BY 4.0</option>
                    <option value="MIT">MIT</option>
                    <option value="ARR">All rights reserved</option>
                  </select>
                </div>
              </div>
            </div>
            <div class="modal-footer">
              <button type="button" class="btn btn-link" data-bs-dismiss="modal">Cancel</button>
              <button type="submit" class="btn btn-accent rounded-0">Create</button>
            </div>
          </form>
        </div>
      </div>
    </div>
  `}async function o(e,t){let n=await fetch(e,{credentials:"include",...t});if(!n.ok){let r="";try{r=JSON.stringify(await n.json())}catch{}throw new Error(`${n.status}: ${r||n.statusText}`)}return await n.json()}async function p(e){let t=e.rootEl.querySelector("#ga-project-list");if(t){t.innerHTML='<div class="text-center p-4 text-muted">Loading\u2026</div>';try{let{projects:n}=await o(`${e.apiBase}/v1/projects/mine`);n.length?t.innerHTML=n.map(C).join(""):t.innerHTML=j()}catch(n){t.innerHTML=`<div class="alert alert-danger">Failed to load projects: ${s(String(n))}</div>`}}}async function T(e,t){return o(`${e.apiBase}/v1/projects`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(t)})}async function L(e,t){return o(`${e.apiBase}/v1/projects/${t}/archive`,{method:"POST"})}function M(e){e.rootEl.addEventListener("click",async n=>{let r=n.target;if(r.matches(".ga-archive-btn")){let a=parseInt(r.getAttribute("data-project-id")||"",10);if(!a||!confirm("Archive this project? The GitHub repo will be archived but its history is preserved."))return;try{await L(e,a),await p(e)}catch(i){alert("Archive failed: "+i)}}}),e.rootEl.querySelector("#ga-new-project-form")?.addEventListener("submit",async n=>{n.preventDefault();let r=e.rootEl.querySelector("#ga-np-title"),a=e.rootEl.querySelector("#ga-np-description"),i=e.rootEl.querySelector("#ga-np-engine"),m=e.rootEl.querySelector("#ga-np-license"),l=e.rootEl.querySelector("#ga-new-project-error");if(!(!r||!i||!m||!l)){l.classList.add("d-none");try{await T(e,{title:r.value,description:a?.value||null,engine:i.value,license:m.value}),r.value="",a&&(a.value="");let c=document.getElementById("ga-new-project-modal");c&&window.bootstrap?.Modal&&window.bootstrap.Modal.getOrCreateInstance(c).hide(),await p(e)}catch(c){l.textContent="Create failed: "+String(c),l.classList.remove("d-none")}}})}var b={async mount(e){v({apiBase:e.apiBase,page:"dashboard"});let t=null;try{t=await o(`${e.apiBase}/v1/me`)}catch{t=null}if(!t){e.onUnauthenticated?.();return}e.rootEl.querySelector("#ga-dashboard-handle").textContent=t.user.handle,e.rootEl.querySelector("#ga-dashboard-address").textContent=t.user.address;let n=e.rootEl.querySelector("#ga-modal-root");n&&!n.innerHTML.trim()&&(n.innerHTML=S()),M(e),await p(e),await $(e)}};async function $(e){let t=e.rootEl.querySelector("#ga-tile-datasets"),n=e.rootEl.querySelector("#ga-tile-models"),r=e.rootEl.querySelector("#ga-tile-wallet");if(t)try{let a=await o(`${e.apiBase}/v1/datasets/mine`);t.textContent=String(a.datasets.length)}catch{t.textContent="\u2014"}if(n)try{let a=await o(`${e.apiBase}/v1/models/mine`);n.textContent=String(a.models.length)}catch{n.textContent="\u2014"}if(r)try{let a=await o(`${e.apiBase}/v1/tokens/account`);r.textContent=`${a.balance.toLocaleString()} tokens`}catch{r.textContent="\u2014"}}window.GADashboard=b;var H=b;export{H as default};
//# sourceMappingURL=ga-dashboard.js.map
