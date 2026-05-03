function i(e){return e.replace(/[&<>"']/g,t=>{switch(t){case"&":return"&amp;";case"<":return"&lt;";case">":return"&gt;";case'"':return"&quot;";default:return"&#39;"}})}async function b(e){let t=await fetch(e,{credentials:"include"});return t.ok?await t.json():{__status:t.status}}function y(e){return typeof e=="object"&&e!==null&&"__status"in e}function x(e){switch(e){case"minted":return"ga-badge ga-badge-minted";case"archived":return"ga-badge ga-badge-archived";case"draft":return"ga-badge ga-badge-draft";default:return"ga-badge ga-badge-published"}}var $={draft:"Draft",published:"Published",minted:"Minted",archived:"Archived"};async function w(e,t,s){let n=document.getElementById("ga-project-tmpl");if(!n)return;let a=n.content.cloneNode(!0),o=a.querySelector(".ga-project-detail");o.querySelector(".ga-project-title").textContent=t.title,o.querySelector(".ga-project-engine").textContent=t.engine,o.querySelector(".ga-project-license").textContent=t.license;let l=o.querySelector(".ga-project-status");l.innerHTML=`<span class="${x(t.status)}">${i($[t.status]||t.status)}</span>`;let u=o.querySelector(".ga-project-description");u.textContent=t.description||"No description yet.";let c=o.querySelector(".ga-project-repo");t.repo_url?(c.href=t.repo_url,c.textContent=(t.repo_full||t.repo_url)+" \u2197"):c.parentElement.innerHTML='<span class="text-muted">Repo not linked.</span>';let p=o.querySelector(".ga-project-cover");t.cover_url&&(p.innerHTML=`<img src="${i(t.cover_url)}" alt="${i(t.title)}" />`);let m=o.querySelector(".ga-project-updated"),d=new Date(t.updated_at*1e3);m.textContent=`Updated ${d.toLocaleDateString()}`;let r=o.querySelector(".ga-project-author");s?(r.href=`/@${s.handle}/`,r.textContent=`@${s.handle}`):(r.removeAttribute("href"),r.textContent=`artist #${t.owner_id}`),e.rootEl.innerHTML="",e.rootEl.appendChild(a),document.title=`${t.title} \u2014 GeneratedArt`}function v(e,t){e.rootEl.innerHTML=`
    <div class="text-center py-10">
      <h1 class="h3 mb-3">Project not found</h1>
      <p class="text-muted small mb-4">${i(t)}</p>
      <a href="/" class="btn btn-outline-primary rounded-0">Back home</a>
    </div>
  `}var _={async mount(e){let s=new URLSearchParams(window.location.search).get("id"),n=s?parseInt(s,10):NaN;if(!n||Number.isNaN(n)){v(e,"No project id provided. Project URLs look like /p/?id=123.");return}let a=await b(`${e.apiBase}/v1/projects/${n}`);if(y(a)){v(e,a.__status===404?`Project #${n} doesn't exist (or has been deleted).`:`Couldn't load project #${n} (${a.__status}).`);return}await w(e,a.project,a.owner??null),await j(e,a.project),await T(e,a.project)}};async function T(e,t){let s=e.rootEl.querySelector(".ga-project-detail");if(!s)return;let n=document.createElement("section");n.className="ga-traits-panel mt-8 pt-6",n.style.borderTop="1px solid var(--ga-rule)",n.innerHTML=`
    <h2 class="h5 mb-1">Traits</h2>
    <p class="small text-muted mb-3">
      Captured at mint time from the artist's <code>$features(seed)</code>.
      Click any value to find other tokens that share it.
    </p>
    <div class="ga-traits-body small">Loading\u2026</div>
    <h2 class="h5 mt-6 mb-1">Recent mints</h2>
    <div class="ga-mints-body small">Loading\u2026</div>
  `,s.appendChild(n);let a=n.querySelector(".ga-traits-body"),o=n.querySelector(".ga-mints-body"),[l,u]=await Promise.all([b(`${e.apiBase}/v1/projects/${t.id}/traits`),b(`${e.apiBase}/v1/projects/${t.id}/mints?limit=20`)]);y(l)||l.minted===0||l.traits.length===0?a.innerHTML='<p class="text-muted">No traits captured yet \u2014 they appear here once tokens are minted.</p>':a.innerHTML=l.traits.map(c=>z(c)).join(""),y(u)||u.mints.length===0?o.innerHTML='<p class="text-muted">No mints yet.</p>':o.innerHTML=`
      <div class="ga-mints-grid">
        ${u.mints.map(c=>L(t.id,c)).join("")}
      </div>`}function z(e){return`
    <div class="ga-trait-group" style="margin-bottom: 14px;">
      <div class="ga-trait-name" style="font-family: var(--ga-font-mono); font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--ga-mute); margin-bottom: 6px;">
        ${i(e.name)}
      </div>
      <ul class="list-unstyled mb-0">
        ${e.values.map(t=>`
          <li style="display:flex; justify-content:space-between; align-items:center; padding: 4px 0; border-bottom: 1px dashed var(--ga-rule);">
            <a href="/explore/?trait=${encodeURIComponent(e.name)}:${encodeURIComponent(t.trait_value)}"
               style="font-family: var(--ga-font-mono); font-size: 13px; color: var(--ga-ink); border-bottom: 1px solid var(--ga-rule);">
              ${i(t.trait_value)}
            </a>
            <span class="text-muted" style="font-family: var(--ga-font-mono); font-size: 12px;">
              ${t.count} \xB7 ${(t.frequency*100).toFixed(1)}%
            </span>
          </li>`).join("")}
      </ul>
    </div>
  `}function L(e,t){let s=`${t.owner_address.slice(0,6)}\u2026${t.owner_address.slice(-4)}`,n=new Date(t.minted_at*1e3).toLocaleDateString(),a=t.traits?Object.keys(t.traits).length:0;return`
    <a class="ga-mint-card" href="/t/?p=${e}&id=${encodeURIComponent(t.token_id)}"
       style="display:block; border:1px solid var(--ga-rule); padding:10px 12px; text-decoration:none; color: inherit;">
      <div style="font-family: var(--ga-font-mono); font-size: 12px; color: var(--ga-ink);">
        #${i(t.token_id)}
      </div>
      <div class="text-muted" style="font-family: var(--ga-font-mono); font-size: 11px; margin-top: 2px;">
        ${i(s)} \xB7 ${i(n)}
      </div>
      <div class="text-muted" style="font-size: 11px; margin-top: 4px;">
        ${a} ${a===1?"trait":"traits"}
      </div>
    </a>
  `}async function j(e,t){let s=e.rootEl.querySelector(".ga-project-detail");if(!s)return;let n=document.createElement("section");n.className="ga-freeze-panel mt-8 pt-6",n.style.borderTop="1px solid var(--ga-rule)",n.innerHTML=`
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
  `,s.appendChild(n);let a=n.querySelector(".ga-freeze-list"),o=n.querySelector(".ga-freeze-actions"),l=n.querySelector(".ga-freeze-status"),u=n.querySelector("[data-action='freeze']"),c=n.querySelector(".ga-freeze-commit"),p=!1;try{let d=await b(`${e.apiBase}/v1/me`);y(d)||(p=d.user.id===t.owner_id)}catch{p=!1}p&&o.classList.remove("d-none");async function m(){let d=await b(`${e.apiBase}/v1/projects/${t.id}/frozen`);if(y(d)){a.innerHTML=`<p class="text-muted">Couldn't load frozen versions (${d.__status}).</p>`;return}if(d.versions.length===0){a.innerHTML=`<p class="text-muted">No frozen versions yet.${p?" Click <em>Freeze current commit</em> to create one.":""}</p>`;return}a.innerHTML=d.versions.map(r=>E(r,p)).join(""),a.querySelectorAll("[data-activate]").forEach(r=>{r.addEventListener("click",async()=>{r.disabled=!0,r.textContent="Activating\u2026";let f=r.getAttribute("data-activate"),g=await fetch(`${e.apiBase}/v1/projects/${t.id}/frozen/${f}/activate`,{method:"POST",credentials:"include"});if(!g.ok){let h=await g.json().catch(()=>({}));l.textContent=`Activate failed: ${h.error||g.status}`}await m()})}),a.querySelectorAll("[data-retry-pin]").forEach(r=>{r.addEventListener("click",async()=>{r.disabled=!0,r.textContent="Retrying\u2026";let f=r.getAttribute("data-retry-pin"),g=await fetch(`${e.apiBase}/v1/projects/${t.id}/frozen/${f}/retry-pin`,{method:"POST",credentials:"include"});if(g.ok)l.textContent="Retry pin succeeded.";else{let h=await g.json().catch(()=>({}));l.textContent=`Retry pin failed: ${h.error||g.status}`}await m()})})}u?.addEventListener("click",async()=>{u.disabled=!0;let d=(c?.value||"").trim()||"latest";l.textContent=d==="latest"?"Building bundle from HEAD + pinning\u2026":`Building bundle from ${d.slice(0,12)} + pinning\u2026`;let r=await fetch(`${e.apiBase}/v1/projects/${t.id}/freeze`,{method:"POST",credentials:"include",headers:{"Content-Type":"application/json"},body:JSON.stringify({commit:d})});if(u.disabled=!1,!r.ok){let f=await r.json().catch(()=>({}));l.textContent=`Freeze failed: ${f.error||r.status}`;return}l.textContent="Frozen. Activate it below to make it the live version.",c&&(c.value=""),await m()}),await m()}function E(e,t){let s=(e.bytes/1024).toFixed(1),n=new Date(e.created_at*1e3).toLocaleString(),a=[e.pinned_w3s?"\u2713 web3.storage":"\u2717 web3.storage",e.pinned_pinata?"\u2713 Pinata":"\u2717 Pinata"].join(" \xB7 "),o=e.pinning_partial?'<span class="ga-badge ga-badge-archived ms-2">Partial pin</span>':"",l=e.is_active?'<span class="ga-badge ga-badge-minted ms-2">Active</span>':"",u=t&&!e.is_active&&(e.pinned_w3s||e.pinned_pinata)?`<button type="button" class="btn btn-sm btn-outline-primary rounded-0 ms-2" data-activate="${e.id}">Activate</button>`:"",c=t&&e.pinning_partial?`<button type="button" class="btn btn-sm btn-outline-secondary rounded-0 ms-2" data-retry-pin="${e.id}" title="Rebuild from commit and re-pin to the dropped provider">Retry pin</button>`:"",p=e.cid_w3s?`<a href="${i(e.gateways.w3s||"")}" target="_blank" rel="noopener">w3s.link \u2197</a> <code style="font-size:11px;">${i(e.cid_w3s.slice(0,18))}\u2026</code>`:'<span class="text-muted">w3s: not pinned</span>',m=e.cid_pinata?`<a href="${i(e.gateways.pinata||"")}" target="_blank" rel="noopener">pinata \u2197</a> <code style="font-size:11px;">${i(e.cid_pinata.slice(0,18))}\u2026</code>`:'<span class="text-muted">pinata: not pinned</span>';return`
    <div class="ga-freeze-row" style="border:1px solid var(--ga-rule); padding:12px; margin-bottom:8px;">
      <div class="d-flex justify-content-between align-items-center mb-1">
        <code style="font-size:12px;">${i(e.cid)}</code>
        <span>${l}${o}${u}${c}</span>
      </div>
      <div class="text-muted" style="font-size:12px; line-height:1.5;">
        <div>commit <code>${i(e.commit_sha.slice(0,12))}</code> \xB7 sha256 <code>${i(e.bundle_hash.slice(0,16))}\u2026</code> \xB7 ${s} KB</div>
        <div>${a} \xB7 ${i(n)}</div>
        <div>${p} \xB7 ${m}</div>
      </div>
    </div>
  `}window.GAProjectDetail=_;var C=_;export{C as default};
//# sourceMappingURL=ga-project-detail.js.map
