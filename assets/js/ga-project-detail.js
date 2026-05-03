function l(e){return e.replace(/[&<>"']/g,t=>{switch(t){case"&":return"&amp;";case"<":return"&lt;";case">":return"&gt;";case'"':return"&quot;";default:return"&#39;"}})}async function b(e){let t=await fetch(e,{credentials:"include"});return t.ok?await t.json():{__status:t.status}}function f(e){return typeof e=="object"&&e!==null&&"__status"in e}function w(e){switch(e){case"minted":return"ga-badge ga-badge-minted";case"archived":return"ga-badge ga-badge-archived";case"draft":return"ga-badge ga-badge-draft";default:return"ga-badge ga-badge-published"}}var y={draft:"Draft",published:"Published",minted:"Minted",archived:"Archived"};async function $(e,t,i){let n=document.getElementById("ga-project-tmpl");if(!n)return;let a=n.content.cloneNode(!0),r=a.querySelector(".ga-project-detail");r.querySelector(".ga-project-title").textContent=t.title,r.querySelector(".ga-project-engine").textContent=t.engine,r.querySelector(".ga-project-license").textContent=t.license;let d=r.querySelector(".ga-project-status");d.innerHTML=`<span class="${w(t.status)}">${l(y[t.status]||t.status)}</span>`;let u=r.querySelector(".ga-project-description");u.textContent=t.description||"No description yet.";let o=r.querySelector(".ga-project-repo");t.repo_url?(o.href=t.repo_url,o.textContent=(t.repo_full||t.repo_url)+" \u2197"):o.parentElement.innerHTML='<span class="text-muted">Repo not linked.</span>';let p=r.querySelector(".ga-project-cover");t.cover_url&&(p.innerHTML=`<img src="${l(t.cover_url)}" alt="${l(t.title)}" />`);let s=r.querySelector(".ga-project-updated"),c=new Date(t.updated_at*1e3);s.textContent=`Updated ${c.toLocaleDateString()}`;let g=r.querySelector(".ga-project-author");i?(g.href=`/@${i.handle}/`,g.textContent=`@${i.handle}`):(g.removeAttribute("href"),g.textContent=`artist #${t.owner_id}`),e.rootEl.innerHTML="",e.rootEl.appendChild(a),document.title=`${t.title} \u2014 GeneratedArt`}function h(e,t){e.rootEl.innerHTML=`
    <div class="text-center py-10">
      <h1 class="h3 mb-3">Project not found</h1>
      <p class="text-muted small mb-4">${l(t)}</p>
      <a href="/" class="btn btn-outline-primary rounded-0">Back home</a>
    </div>
  `}var _={async mount(e){let i=new URLSearchParams(window.location.search).get("id"),n=i?parseInt(i,10):NaN;if(!n||Number.isNaN(n)){h(e,"No project id provided. Project URLs look like /p/?id=123.");return}let a=await b(`${e.apiBase}/v1/projects/${n}`);if(f(a)){h(e,a.__status===404?`Project #${n} doesn't exist (or has been deleted).`:`Couldn't load project #${n} (${a.__status}).`);return}await $(e,a.project,a.owner??null),await x(e,a.project)}};async function x(e,t){let i=e.rootEl.querySelector(".ga-project-detail");if(!i)return;let n=document.createElement("section");n.className="ga-freeze-panel mt-8 pt-6",n.style.borderTop="1px solid var(--ga-rule)",n.innerHTML=`
    <h2 class="h5 mb-1">Frozen versions</h2>
    <p class="small text-muted mb-3">
      Each frozen version is a deterministic, content-addressed bundle
      pinned to web3.storage and Pinata. The active version's CID is
      what gets locked into the project contract at mint time.
    </p>
    <div class="ga-freeze-actions mb-3 d-none">
      <button type="button" class="btn btn-accent btn-sm rounded-0" data-action="freeze">
        Freeze current commit
      </button>
      <span class="ga-freeze-status small text-muted ms-2"></span>
    </div>
    <div class="ga-freeze-list small">Loading\u2026</div>
  `,i.appendChild(n);let a=n.querySelector(".ga-freeze-list"),r=n.querySelector(".ga-freeze-actions"),d=n.querySelector(".ga-freeze-status"),u=n.querySelector("[data-action='freeze']"),o=!1;try{let s=await b(`${e.apiBase}/v1/me`);f(s)||(o=s.user.id===t.owner_id)}catch{o=!1}o&&r.classList.remove("d-none");async function p(){let s=await b(`${e.apiBase}/v1/projects/${t.id}/frozen`);if(f(s)){a.innerHTML=`<p class="text-muted">Couldn't load frozen versions (${s.__status}).</p>`;return}if(s.versions.length===0){a.innerHTML=`<p class="text-muted">No frozen versions yet.${o?" Click <em>Freeze current commit</em> to create one.":""}</p>`;return}a.innerHTML=s.versions.map(c=>z(c,o,t.id)).join(""),a.querySelectorAll("[data-activate]").forEach(c=>{c.addEventListener("click",async()=>{c.disabled=!0,c.textContent="Activating\u2026";let g=c.getAttribute("data-activate"),m=await fetch(`${e.apiBase}/v1/projects/${t.id}/frozen/${g}/activate`,{method:"POST",credentials:"include"});if(!m.ok){let v=await m.json().catch(()=>({}));d.textContent=`Activate failed: ${v.error||m.status}`}await p()})})}u?.addEventListener("click",async()=>{u.disabled=!0,d.textContent="Building bundle + pinning\u2026";let s=await fetch(`${e.apiBase}/v1/projects/${t.id}/freeze`,{method:"POST",credentials:"include",headers:{"Content-Type":"application/json"},body:JSON.stringify({commit:"latest"})});if(u.disabled=!1,!s.ok){let c=await s.json().catch(()=>({}));d.textContent=`Freeze failed: ${c.error||s.status}`;return}d.textContent="Frozen. Activate it below to make it the live version.",await p()}),await p()}function z(e,t,i){let n=i,a=(e.bytes/1024).toFixed(1),r=new Date(e.created_at*1e3).toLocaleString(),d=[e.pinned_w3s?"\u2713 web3.storage":"\u2717 web3.storage",e.pinned_pinata?"\u2713 Pinata":"\u2717 Pinata"].join(" \xB7 "),u=e.pinning_partial?'<span class="ga-badge ga-badge-archived ms-2">Partial pin</span>':"",o=e.is_active?'<span class="ga-badge ga-badge-minted ms-2">Active</span>':"",p=t&&!e.is_active&&(e.pinned_w3s||e.pinned_pinata)?`<button type="button" class="btn btn-sm btn-outline-primary rounded-0 ms-2" data-activate="${e.id}">Activate</button>`:"";return`
    <div class="ga-freeze-row" style="border:1px solid var(--ga-rule); padding:12px; margin-bottom:8px;">
      <div class="d-flex justify-content-between align-items-center mb-1">
        <code style="font-size:12px;">${l(e.cid)}</code>
        <span>${o}${u}${p}</span>
      </div>
      <div class="text-muted" style="font-size:12px; line-height:1.5;">
        <div>commit <code>${l(e.commit_sha.slice(0,12))}</code> \xB7 sha256 <code>${l(e.bundle_hash.slice(0,16))}\u2026</code> \xB7 ${a} KB</div>
        <div>${d} \xB7 ${l(r)}</div>
        <div>
          <a href="${l(e.gateways.w3s)}" target="_blank" rel="noopener">w3s.link \u2197</a>
          \xB7
          <a href="${l(e.gateways.pinata)}" target="_blank" rel="noopener">pinata \u2197</a>
        </div>
      </div>
    </div>
  `}window.GAProjectDetail=_;var T=_;export{T as default};
//# sourceMappingURL=ga-project-detail.js.map
