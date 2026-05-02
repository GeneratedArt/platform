var m={draft:"Draft",published:"Published",minted:"Minted",archived:"Archived"};function g(e){return`<span class="${`ga-badge ga-badge-${e}`}">${m[e]||e}</span>`}function o(e){return e.replace(/[&<>"']/g,t=>{switch(t){case"&":return"&amp;";case"<":return"&lt;";case">":return"&gt;";case'"':return"&quot;";default:return"&#39;"}})}function v(e){let t=e.status==="archived",a=e.repo_url?`<a href="${o(e.repo_url)}" target="_blank" rel="noopener" class="ga-card-link">View repo \u2192</a>`:"",r=t?"":`<button class="btn btn-link p-0 text-danger ga-archive-btn" data-project-id="${e.id}">Archive</button>`;return`
    <article class="ga-project-card" data-project-id="${e.id}">
      <header>
        <h3 class="h5 mb-1">${o(e.title)}</h3>
        <p class="small text-muted mb-2">${o(e.engine)} \xB7 ${o(e.license)}</p>
      </header>
      <p class="small mb-3">${o(e.description||"No description yet.")}</p>
      <footer class="d-flex justify-content-between align-items-center">
        <div>${g(e.status)}</div>
        <div class="d-flex gap-3 align-items-center">
          ${a}
          ${r}
        </div>
      </footer>
    </article>
  `}function b(){return`
    <div class="ga-empty p-6 text-center">
      <h3 class="h5 mb-2">No projects yet.</h3>
      <p class="small text-muted mb-0">Click "New project" to create your first generative-art repo.</p>
    </div>
  `}function h(){return`
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
  `}async function c(e,t){let a=await fetch(e,{credentials:"include",...t});if(!a.ok){let r="";try{r=JSON.stringify(await a.json())}catch{}throw new Error(`${a.status}: ${r||a.statusText}`)}return await a.json()}async function d(e){let t=e.rootEl.querySelector("#ga-project-list");if(t){t.innerHTML='<div class="text-center p-4 text-muted">Loading\u2026</div>';try{let{projects:a}=await c(`${e.apiBase}/v1/projects/mine`);a.length?t.innerHTML=a.map(v).join(""):t.innerHTML=b()}catch(a){t.innerHTML=`<div class="alert alert-danger">Failed to load projects: ${o(String(a))}</div>`}}}async function f(e,t){return c(`${e.apiBase}/v1/projects`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(t)})}async function y(e,t){return c(`${e.apiBase}/v1/projects/${t}/archive`,{method:"POST"})}function E(e){e.rootEl.addEventListener("click",async a=>{let r=a.target;if(r.matches(".ga-archive-btn")){let n=parseInt(r.getAttribute("data-project-id")||"",10);if(!n||!confirm("Archive this project? The GitHub repo will be archived but its history is preserved."))return;try{await y(e,n),await d(e)}catch(s){alert("Archive failed: "+s)}}}),e.rootEl.querySelector("#ga-new-project-form")?.addEventListener("submit",async a=>{a.preventDefault();let r=e.rootEl.querySelector("#ga-np-title"),n=e.rootEl.querySelector("#ga-np-description"),s=e.rootEl.querySelector("#ga-np-engine"),u=e.rootEl.querySelector("#ga-np-license"),i=e.rootEl.querySelector("#ga-new-project-error");if(!(!r||!s||!u||!i)){i.classList.add("d-none");try{await f(e,{title:r.value,description:n?.value||null,engine:s.value,license:u.value}),r.value="",n&&(n.value="");let l=document.getElementById("ga-new-project-modal");l&&window.bootstrap?.Modal&&window.bootstrap.Modal.getOrCreateInstance(l).hide(),await d(e)}catch(l){i.textContent="Create failed: "+String(l),i.classList.remove("d-none")}}})}var p={async mount(e){let t=null;try{t=await c(`${e.apiBase}/v1/me`)}catch{t=null}if(!t){e.onUnauthenticated?.();return}e.rootEl.querySelector("#ga-dashboard-handle").textContent=t.user.handle,e.rootEl.querySelector("#ga-dashboard-address").textContent=t.user.address;let a=e.rootEl.querySelector("#ga-modal-root");a&&!a.innerHTML.trim()&&(a.innerHTML=h()),E(e),await d(e)}};window.GADashboard=p;var j=p;export{j as default};
//# sourceMappingURL=ga-dashboard.js.map
