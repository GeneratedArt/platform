function o(e){return e.replace(/[&<>"']/g,t=>{switch(t){case"&":return"&amp;";case"<":return"&lt;";case">":return"&gt;";case'"':return"&quot;";default:return"&#39;"}})}async function h(e){let t=await fetch(e,{credentials:"include"});return t.ok?await t.json():{__status:t.status}}function y(e){return typeof e=="object"&&e!==null&&"__status"in e}function v(e){switch(e){case"minted":return"ga-badge ga-badge-minted";case"archived":return"ga-badge ga-badge-archived";case"draft":return"ga-badge ga-badge-draft";default:return"ga-badge ga-badge-published"}}var $={draft:"Draft",published:"Published",minted:"Minted",archived:"Archived"};async function x(e,t,l){let n=document.getElementById("ga-project-tmpl");if(!n)return;let r=n.content.cloneNode(!0),i=r.querySelector(".ga-project-detail");i.querySelector(".ga-project-title").textContent=t.title,i.querySelector(".ga-project-engine").textContent=t.engine,i.querySelector(".ga-project-license").textContent=t.license;let c=i.querySelector(".ga-project-status");c.innerHTML=`<span class="${v(t.status)}">${o($[t.status]||t.status)}</span>`;let m=i.querySelector(".ga-project-description");m.textContent=t.description||"No description yet.";let d=i.querySelector(".ga-project-repo");t.repo_url?(d.href=t.repo_url,d.textContent=(t.repo_full||t.repo_url)+" \u2197"):d.parentElement.innerHTML='<span class="text-muted">Repo not linked.</span>';let u=i.querySelector(".ga-project-cover");t.cover_url&&(u.innerHTML=`<img src="${o(t.cover_url)}" alt="${o(t.title)}" />`);let p=i.querySelector(".ga-project-updated"),s=new Date(t.updated_at*1e3);p.textContent=`Updated ${s.toLocaleDateString()}`;let a=i.querySelector(".ga-project-author");l?(a.href=`/@${l.handle}/`,a.textContent=`@${l.handle}`):(a.removeAttribute("href"),a.textContent=`artist #${t.owner_id}`),e.rootEl.innerHTML="",e.rootEl.appendChild(r),document.title=`${t.title} \u2014 GeneratedArt`}function _(e,t){e.rootEl.innerHTML=`
    <div class="text-center py-10">
      <h1 class="h3 mb-3">Project not found</h1>
      <p class="text-muted small mb-4">${o(t)}</p>
      <a href="/" class="btn btn-outline-primary rounded-0">Back home</a>
    </div>
  `}var w={async mount(e){let l=new URLSearchParams(window.location.search).get("id"),n=l?parseInt(l,10):NaN;if(!n||Number.isNaN(n)){_(e,"No project id provided. Project URLs look like /p/?id=123.");return}let r=await h(`${e.apiBase}/v1/projects/${n}`);if(y(r)){_(e,r.__status===404?`Project #${n} doesn't exist (or has been deleted).`:`Couldn't load project #${n} (${r.__status}).`);return}await x(e,r.project,r.owner??null),await z(e,r.project)}};async function z(e,t){let l=e.rootEl.querySelector(".ga-project-detail");if(!l)return;let n=document.createElement("section");n.className="ga-freeze-panel mt-8 pt-6",n.style.borderTop="1px solid var(--ga-rule)",n.innerHTML=`
    <h2 class="h5 mb-1">Frozen versions</h2>
    <p class="small text-muted mb-3">
      Each frozen version is a deterministic, content-addressed bundle
      pinned to web3.storage and Pinata. The active version's CID is
      what gets locked into the project contract at mint time.
    </p>
    <div class="ga-freeze-actions mb-3 d-none">
      <div class="d-flex flex-wrap align-items-center gap-2">
        <input type="text"
          class="ga-freeze-commit form-control form-control-sm rounded-0"
          style="max-width:280px;font-family:monospace;font-size:12px;"
          placeholder="commit SHA (blank = latest)"
          aria-label="Commit SHA to freeze" />
        <button type="button" class="btn btn-accent btn-sm rounded-0" data-action="freeze">
          Freeze
        </button>
        <span class="ga-freeze-status small text-muted ms-2"></span>
      </div>
      <p class="small text-muted mt-1 mb-0">
        Leave commit blank to freeze the default branch's HEAD.
      </p>
    </div>
    <div class="ga-freeze-list small">Loading\u2026</div>
  `,l.appendChild(n);let r=n.querySelector(".ga-freeze-list"),i=n.querySelector(".ga-freeze-actions"),c=n.querySelector(".ga-freeze-status"),m=n.querySelector("[data-action='freeze']"),d=n.querySelector(".ga-freeze-commit"),u=!1;try{let s=await h(`${e.apiBase}/v1/me`);y(s)||(u=s.user.id===t.owner_id)}catch{u=!1}u&&i.classList.remove("d-none");async function p(){let s=await h(`${e.apiBase}/v1/projects/${t.id}/frozen`);if(y(s)){r.innerHTML=`<p class="text-muted">Couldn't load frozen versions (${s.__status}).</p>`;return}if(s.versions.length===0){r.innerHTML=`<p class="text-muted">No frozen versions yet.${u?" Click <em>Freeze current commit</em> to create one.":""}</p>`;return}r.innerHTML=s.versions.map(a=>L(a,u)).join(""),r.querySelectorAll("[data-activate]").forEach(a=>{a.addEventListener("click",async()=>{a.disabled=!0,a.textContent="Activating\u2026";let f=a.getAttribute("data-activate"),g=await fetch(`${e.apiBase}/v1/projects/${t.id}/frozen/${f}/activate`,{method:"POST",credentials:"include"});if(!g.ok){let b=await g.json().catch(()=>({}));c.textContent=`Activate failed: ${b.error||g.status}`}await p()})}),r.querySelectorAll("[data-retry-pin]").forEach(a=>{a.addEventListener("click",async()=>{a.disabled=!0,a.textContent="Retrying\u2026";let f=a.getAttribute("data-retry-pin"),g=await fetch(`${e.apiBase}/v1/projects/${t.id}/frozen/${f}/retry-pin`,{method:"POST",credentials:"include"});if(g.ok)c.textContent="Retry pin succeeded.";else{let b=await g.json().catch(()=>({}));c.textContent=`Retry pin failed: ${b.error||g.status}`}await p()})})}m?.addEventListener("click",async()=>{m.disabled=!0;let s=(d?.value||"").trim()||"latest";c.textContent=s==="latest"?"Building bundle from HEAD + pinning\u2026":`Building bundle from ${s.slice(0,12)} + pinning\u2026`;let a=await fetch(`${e.apiBase}/v1/projects/${t.id}/freeze`,{method:"POST",credentials:"include",headers:{"Content-Type":"application/json"},body:JSON.stringify({commit:s})});if(m.disabled=!1,!a.ok){let f=await a.json().catch(()=>({}));c.textContent=`Freeze failed: ${f.error||a.status}`;return}c.textContent="Frozen. Activate it below to make it the live version.",d&&(d.value=""),await p()}),await p()}function L(e,t){let l=(e.bytes/1024).toFixed(1),n=new Date(e.created_at*1e3).toLocaleString(),r=[e.pinned_w3s?"\u2713 web3.storage":"\u2717 web3.storage",e.pinned_pinata?"\u2713 Pinata":"\u2717 Pinata"].join(" \xB7 "),i=e.pinning_partial?'<span class="ga-badge ga-badge-archived ms-2">Partial pin</span>':"",c=e.is_active?'<span class="ga-badge ga-badge-minted ms-2">Active</span>':"",m=t&&!e.is_active&&(e.pinned_w3s||e.pinned_pinata)?`<button type="button" class="btn btn-sm btn-outline-primary rounded-0 ms-2" data-activate="${e.id}">Activate</button>`:"",d=t&&e.pinning_partial?`<button type="button" class="btn btn-sm btn-outline-secondary rounded-0 ms-2" data-retry-pin="${e.id}" title="Rebuild from commit and re-pin to the dropped provider">Retry pin</button>`:"",u=e.cid_w3s?`<a href="${o(e.gateways.w3s||"")}" target="_blank" rel="noopener">w3s.link \u2197</a> <code style="font-size:11px;">${o(e.cid_w3s.slice(0,18))}\u2026</code>`:'<span class="text-muted">w3s: not pinned</span>',p=e.cid_pinata?`<a href="${o(e.gateways.pinata||"")}" target="_blank" rel="noopener">pinata \u2197</a> <code style="font-size:11px;">${o(e.cid_pinata.slice(0,18))}\u2026</code>`:'<span class="text-muted">pinata: not pinned</span>';return`
    <div class="ga-freeze-row" style="border:1px solid var(--ga-rule); padding:12px; margin-bottom:8px;">
      <div class="d-flex justify-content-between align-items-center mb-1">
        <code style="font-size:12px;">${o(e.cid)}</code>
        <span>${c}${i}${m}${d}</span>
      </div>
      <div class="text-muted" style="font-size:12px; line-height:1.5;">
        <div>commit <code>${o(e.commit_sha.slice(0,12))}</code> \xB7 sha256 <code>${o(e.bundle_hash.slice(0,16))}\u2026</code> \xB7 ${l} KB</div>
        <div>${r} \xB7 ${o(n)}</div>
        <div>${u} \xB7 ${p}</div>
      </div>
    </div>
  `}window.GAProjectDetail=w;var E=w;export{E as default};
//# sourceMappingURL=ga-project-detail.js.map
