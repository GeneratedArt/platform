var u=new Set,f=10,g=!1,c=null;function v(e){g||(g=!0,c=e,window.addEventListener("error",t=>{let r=t.error&&t.error.message||t.message||"unknown_error",n=t.error&&t.error.stack||`${t.filename??""}:${t.lineno??0}:${t.colno??0}`;h(r,n)}),window.addEventListener("unhandledrejection",t=>{let r=t.reason,n=r instanceof Error?r.message:typeof r=="string"?r:"unhandled_rejection",a=r instanceof Error?r.stack??"":"";h(n,a)}))}async function h(e,t){if(!c||u.size>=f)return;let r=`${e}::${t.slice(0,80)}`;if(!u.has(r)){u.add(r);try{await fetch(`${c.apiBase}/v1/internal/client-error`,{method:"POST",credentials:"include",headers:{"Content-Type":"application/json"},body:JSON.stringify({message:String(e).slice(0,500),stack:String(t).slice(0,4e3),page:c.page,url:location.href.slice(0,200),ts:Date.now()}),keepalive:!0})}catch{}}}var E={draft:"Draft",published:"Published",minted:"Minted",archived:"Archived"};function y(e){return`<span class="${`ga-badge ga-badge-${e}`}">${E[e]||e}</span>`}function o(e){return e.replace(/[&<>"']/g,t=>{switch(t){case"&":return"&amp;";case"<":return"&lt;";case">":return"&gt;";case'"':return"&quot;";default:return"&#39;"}})}function j(e){let t=e.status==="archived",r=e.repo_url?`<a href="${o(e.repo_url)}" target="_blank" rel="noopener" class="ga-card-link">View repo \u2192</a>`:"",n=t?"":`<button class="btn btn-link p-0 text-danger ga-archive-btn" data-project-id="${e.id}">Archive</button>`;return`
    <article class="ga-project-card" data-project-id="${e.id}">
      <header>
        <h3 class="h5 mb-1">${o(e.title)}</h3>
        <p class="small text-muted mb-2">${o(e.engine)} \xB7 ${o(e.license)}</p>
      </header>
      <p class="small mb-3">${o(e.description||"No description yet.")}</p>
      <footer class="d-flex justify-content-between align-items-center">
        <div>${y(e.status)}</div>
        <div class="d-flex gap-3 align-items-center">
          ${r}
          ${n}
        </div>
      </footer>
    </article>
  `}function w(){return`
    <div class="ga-empty p-6 text-center">
      <h3 class="h5 mb-2">No projects yet.</h3>
      <p class="small text-muted mb-0">Click "New project" to create your first generative-art repo.</p>
    </div>
  `}function C(){return`
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
  `}async function d(e,t){let r=await fetch(e,{credentials:"include",...t});if(!r.ok){let n="";try{n=JSON.stringify(await r.json())}catch{}throw new Error(`${r.status}: ${n||r.statusText}`)}return await r.json()}async function p(e){let t=e.rootEl.querySelector("#ga-project-list");if(t){t.innerHTML='<div class="text-center p-4 text-muted">Loading\u2026</div>';try{let{projects:r}=await d(`${e.apiBase}/v1/projects/mine`);r.length?t.innerHTML=r.map(j).join(""):t.innerHTML=w()}catch(r){t.innerHTML=`<div class="alert alert-danger">Failed to load projects: ${o(String(r))}</div>`}}}async function S(e,t){return d(`${e.apiBase}/v1/projects`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(t)})}async function T(e,t){return d(`${e.apiBase}/v1/projects/${t}/archive`,{method:"POST"})}function M(e){e.rootEl.addEventListener("click",async r=>{let n=r.target;if(n.matches(".ga-archive-btn")){let a=parseInt(n.getAttribute("data-project-id")||"",10);if(!a||!confirm("Archive this project? The GitHub repo will be archived but its history is preserved."))return;try{await T(e,a),await p(e)}catch(s){alert("Archive failed: "+s)}}}),e.rootEl.querySelector("#ga-new-project-form")?.addEventListener("submit",async r=>{r.preventDefault();let n=e.rootEl.querySelector("#ga-np-title"),a=e.rootEl.querySelector("#ga-np-description"),s=e.rootEl.querySelector("#ga-np-engine"),m=e.rootEl.querySelector("#ga-np-license"),i=e.rootEl.querySelector("#ga-new-project-error");if(!(!n||!s||!m||!i)){i.classList.add("d-none");try{await S(e,{title:n.value,description:a?.value||null,engine:s.value,license:m.value}),n.value="",a&&(a.value="");let l=document.getElementById("ga-new-project-modal");l&&window.bootstrap?.Modal&&window.bootstrap.Modal.getOrCreateInstance(l).hide(),await p(e)}catch(l){i.textContent="Create failed: "+String(l),i.classList.remove("d-none")}}})}var b={async mount(e){v({apiBase:e.apiBase,page:"dashboard"});let t=null;try{t=await d(`${e.apiBase}/v1/me`)}catch{t=null}if(!t){e.onUnauthenticated?.();return}e.rootEl.querySelector("#ga-dashboard-handle").textContent=t.user.handle,e.rootEl.querySelector("#ga-dashboard-address").textContent=t.user.address;let r=e.rootEl.querySelector("#ga-modal-root");r&&!r.innerHTML.trim()&&(r.innerHTML=C()),M(e),await p(e)}};window.GADashboard=b;var B=b;export{B as default};
//# sourceMappingURL=ga-dashboard.js.map
