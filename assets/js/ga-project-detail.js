function s(e){return e.replace(/[&<>"']/g,t=>{switch(t){case"&":return"&amp;";case"<":return"&lt;";case">":return"&gt;";case'"':return"&quot;";default:return"&#39;"}})}async function f(e){let t=await fetch(e,{credentials:"include"});return t.ok?await t.json():{__status:t.status}}function b(e){return typeof e=="object"&&e!==null&&"__status"in e}function x(e){switch(e){case"minted":return"ga-badge ga-badge-minted";case"archived":return"ga-badge ga-badge-archived";case"draft":return"ga-badge ga-badge-draft";default:return"ga-badge ga-badge-published"}}var $={draft:"Draft",published:"Published",minted:"Minted",archived:"Archived"};async function w(e,t,o){let n=document.getElementById("ga-project-tmpl");if(!n)return;let a=n.content.cloneNode(!0),r=a.querySelector(".ga-project-detail");r.querySelector(".ga-project-title").textContent=t.title,r.querySelector(".ga-project-engine").textContent=t.engine,r.querySelector(".ga-project-license").textContent=t.license;let l=r.querySelector(".ga-project-status");l.innerHTML=`<span class="${x(t.status)}">${s($[t.status]||t.status)}</span>`;let u=r.querySelector(".ga-project-description");u.textContent=t.description||"No description yet.";let c=r.querySelector(".ga-project-repo");t.repo_url?(c.href=t.repo_url,c.textContent=(t.repo_full||t.repo_url)+" \u2197"):c.parentElement.innerHTML='<span class="text-muted">Repo not linked.</span>';let p=r.querySelector(".ga-project-cover");t.cover_url&&(p.innerHTML=`<img src="${s(t.cover_url)}" alt="${s(t.title)}" />`);let m=r.querySelector(".ga-project-updated"),d=new Date(t.updated_at*1e3);m.textContent=`Updated ${d.toLocaleDateString()}`;let i=r.querySelector(".ga-project-author");o?(i.href=`/@${o.handle}/`,i.textContent=`@${o.handle}`):(i.removeAttribute("href"),i.textContent=`artist #${t.owner_id}`),e.rootEl.innerHTML="",e.rootEl.appendChild(a),document.title=`${t.title} \u2014 GeneratedArt`}function v(e,t){e.rootEl.innerHTML=`
    <div class="text-center py-10">
      <h1 class="h3 mb-3">Project not found</h1>
      <p class="text-muted small mb-4">${s(t)}</p>
      <a href="/" class="btn btn-outline-primary rounded-0">Back home</a>
    </div>
  `}var _={async mount(e){let o=new URLSearchParams(window.location.search).get("id"),n=o?parseInt(o,10):NaN;if(!n||Number.isNaN(n)){v(e,"No project id provided. Project URLs look like /p/?id=123.");return}let a=await f(`${e.apiBase}/v1/projects/${n}`);if(b(a)){v(e,a.__status===404?`Project #${n} doesn't exist (or has been deleted).`:`Couldn't load project #${n} (${a.__status}).`);return}await w(e,a.project,a.owner??null),await j(e,a.project),await C(e,a.project),await T(e,a.project)}};async function j(e,t){let o=e.rootEl.querySelector(".ga-project-detail");if(!o)return;let n=await f(`${e.apiBase}/v1/projects/${t.id}/galleries`);if(b(n)||n.galleries.length===0)return;let a=document.createElement("section");a.className="ga-curated-by-panel mt-8 pt-6",a.style.borderTop="1px solid var(--ga-rule)",a.innerHTML=`
    <h2 class="h5 mb-2">Curated by</h2>
    <ul class="list-unstyled mb-0">
      ${n.galleries.map(r=>`
        <li class="py-2" style="border-bottom: 1px dashed var(--ga-rule);">
          <a href="/galleries/${s(r.slug)}/"
             style="font-family: var(--ga-font-mono); font-size: 14px; color: var(--ga-ink); border-bottom: 1px solid var(--ga-rule);">
            ${s(r.title)}
          </a>
          <span class="text-muted small ms-2">
            \xB7 @${s(r.curator_handle)}
          </span>
        </li>`).join("")}
    </ul>
  `,o.appendChild(a)}async function T(e,t){let o=e.rootEl.querySelector(".ga-project-detail");if(!o)return;let n=document.createElement("section");n.className="ga-traits-panel mt-8 pt-6",n.style.borderTop="1px solid var(--ga-rule)",n.innerHTML=`
    <h2 class="h5 mb-1">Traits</h2>
    <p class="small text-muted mb-3">
      Captured at mint time from the artist's <code>$features(seed)</code>.
      Click any value to find other tokens that share it.
    </p>
    <div class="ga-traits-body small">Loading\u2026</div>
    <h2 class="h5 mt-6 mb-1">Recent mints</h2>
    <div class="ga-mints-body small">Loading\u2026</div>
  `,o.appendChild(n);let a=n.querySelector(".ga-traits-body"),r=n.querySelector(".ga-mints-body"),[l,u]=await Promise.all([f(`${e.apiBase}/v1/projects/${t.id}/traits`),f(`${e.apiBase}/v1/projects/${t.id}/mints?limit=20`)]);b(l)||l.minted===0||l.traits.length===0?a.innerHTML='<p class="text-muted">No traits captured yet \u2014 they appear here once tokens are minted.</p>':a.innerHTML=l.traits.map(c=>z(c)).join(""),b(u)||u.mints.length===0?r.innerHTML='<p class="text-muted">No mints yet.</p>':r.innerHTML=`
      <div class="ga-mints-grid">
        ${u.mints.map(c=>L(t.id,c)).join("")}
      </div>`}function z(e){return`
    <div class="ga-trait-group" style="margin-bottom: 14px;">
      <div class="ga-trait-name" style="font-family: var(--ga-font-mono); font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--ga-mute); margin-bottom: 6px;">
        ${s(e.name)}
      </div>
      <ul class="list-unstyled mb-0">
        ${e.values.map(t=>`
          <li style="display:flex; justify-content:space-between; align-items:center; padding: 4px 0; border-bottom: 1px dashed var(--ga-rule);">
            <a href="/explore/?trait=${encodeURIComponent(e.name)}:${encodeURIComponent(t.trait_value)}"
               style="font-family: var(--ga-font-mono); font-size: 13px; color: var(--ga-ink); border-bottom: 1px solid var(--ga-rule);">
              ${s(t.trait_value)}
            </a>
            <span class="text-muted" style="font-family: var(--ga-font-mono); font-size: 12px;">
              ${t.count} \xB7 ${(t.frequency*100).toFixed(1)}%
            </span>
          </li>`).join("")}
      </ul>
    </div>
  `}function L(e,t){let o=`${t.owner_address.slice(0,6)}\u2026${t.owner_address.slice(-4)}`,n=new Date(t.minted_at*1e3).toLocaleDateString(),a=t.traits?Object.keys(t.traits).length:0;return`
    <a class="ga-mint-card" href="/t/?p=${e}&id=${encodeURIComponent(t.token_id)}"
       style="display:block; border:1px solid var(--ga-rule); padding:10px 12px; text-decoration:none; color: inherit;">
      <div style="font-family: var(--ga-font-mono); font-size: 12px; color: var(--ga-ink);">
        #${s(t.token_id)}
      </div>
      <div class="text-muted" style="font-family: var(--ga-font-mono); font-size: 11px; margin-top: 2px;">
        ${s(o)} \xB7 ${s(n)}
      </div>
      <div class="text-muted" style="font-size: 11px; margin-top: 4px;">
        ${a} ${a===1?"trait":"traits"}
      </div>
    </a>
  `}async function C(e,t){let o=e.rootEl.querySelector(".ga-project-detail");if(!o)return;let n=document.createElement("section");n.className="ga-freeze-panel mt-8 pt-6",n.style.borderTop="1px solid var(--ga-rule)",n.innerHTML=`
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
  `,o.appendChild(n);let a=n.querySelector(".ga-freeze-list"),r=n.querySelector(".ga-freeze-actions"),l=n.querySelector(".ga-freeze-status"),u=n.querySelector("[data-action='freeze']"),c=n.querySelector(".ga-freeze-commit"),p=!1;try{let d=await f(`${e.apiBase}/v1/me`);b(d)||(p=d.user.id===t.owner_id)}catch{p=!1}p&&r.classList.remove("d-none");async function m(){let d=await f(`${e.apiBase}/v1/projects/${t.id}/frozen`);if(b(d)){a.innerHTML=`<p class="text-muted">Couldn't load frozen versions (${d.__status}).</p>`;return}if(d.versions.length===0){a.innerHTML=`<p class="text-muted">No frozen versions yet.${p?" Click <em>Freeze current commit</em> to create one.":""}</p>`;return}a.innerHTML=d.versions.map(i=>E(i,p)).join(""),a.querySelectorAll("[data-activate]").forEach(i=>{i.addEventListener("click",async()=>{i.disabled=!0,i.textContent="Activating\u2026";let y=i.getAttribute("data-activate"),g=await fetch(`${e.apiBase}/v1/projects/${t.id}/frozen/${y}/activate`,{method:"POST",credentials:"include"});if(!g.ok){let h=await g.json().catch(()=>({}));l.textContent=`Activate failed: ${h.error||g.status}`}await m()})}),a.querySelectorAll("[data-retry-pin]").forEach(i=>{i.addEventListener("click",async()=>{i.disabled=!0,i.textContent="Retrying\u2026";let y=i.getAttribute("data-retry-pin"),g=await fetch(`${e.apiBase}/v1/projects/${t.id}/frozen/${y}/retry-pin`,{method:"POST",credentials:"include"});if(g.ok)l.textContent="Retry pin succeeded.";else{let h=await g.json().catch(()=>({}));l.textContent=`Retry pin failed: ${h.error||g.status}`}await m()})})}u?.addEventListener("click",async()=>{u.disabled=!0;let d=(c?.value||"").trim()||"latest";l.textContent=d==="latest"?"Building bundle from HEAD + pinning\u2026":`Building bundle from ${d.slice(0,12)} + pinning\u2026`;let i=await fetch(`${e.apiBase}/v1/projects/${t.id}/freeze`,{method:"POST",credentials:"include",headers:{"Content-Type":"application/json"},body:JSON.stringify({commit:d})});if(u.disabled=!1,!i.ok){let y=await i.json().catch(()=>({}));l.textContent=`Freeze failed: ${y.error||i.status}`;return}l.textContent="Frozen. Activate it below to make it the live version.",c&&(c.value=""),await m()}),await m()}function E(e,t){let o=(e.bytes/1024).toFixed(1),n=new Date(e.created_at*1e3).toLocaleString(),a=[e.pinned_w3s?"\u2713 web3.storage":"\u2717 web3.storage",e.pinned_pinata?"\u2713 Pinata":"\u2717 Pinata"].join(" \xB7 "),r=e.pinning_partial?'<span class="ga-badge ga-badge-archived ms-2">Partial pin</span>':"",l=e.is_active?'<span class="ga-badge ga-badge-minted ms-2">Active</span>':"",u=t&&!e.is_active&&(e.pinned_w3s||e.pinned_pinata)?`<button type="button" class="btn btn-sm btn-outline-primary rounded-0 ms-2" data-activate="${e.id}">Activate</button>`:"",c=t&&e.pinning_partial?`<button type="button" class="btn btn-sm btn-outline-secondary rounded-0 ms-2" data-retry-pin="${e.id}" title="Rebuild from commit and re-pin to the dropped provider">Retry pin</button>`:"",p=e.cid_w3s?`<a href="${s(e.gateways.w3s||"")}" target="_blank" rel="noopener">w3s.link \u2197</a> <code style="font-size:11px;">${s(e.cid_w3s.slice(0,18))}\u2026</code>`:'<span class="text-muted">w3s: not pinned</span>',m=e.cid_pinata?`<a href="${s(e.gateways.pinata||"")}" target="_blank" rel="noopener">pinata \u2197</a> <code style="font-size:11px;">${s(e.cid_pinata.slice(0,18))}\u2026</code>`:'<span class="text-muted">pinata: not pinned</span>';return`
    <div class="ga-freeze-row" style="border:1px solid var(--ga-rule); padding:12px; margin-bottom:8px;">
      <div class="d-flex justify-content-between align-items-center mb-1">
        <code style="font-size:12px;">${s(e.cid)}</code>
        <span>${l}${r}${u}${c}</span>
      </div>
      <div class="text-muted" style="font-size:12px; line-height:1.5;">
        <div>commit <code>${s(e.commit_sha.slice(0,12))}</code> \xB7 sha256 <code>${s(e.bundle_hash.slice(0,16))}\u2026</code> \xB7 ${o} KB</div>
        <div>${a} \xB7 ${s(n)}</div>
        <div>${p} \xB7 ${m}</div>
      </div>
    </div>
  `}window.GAProjectDetail=_;var P=_;export{P as default};
//# sourceMappingURL=ga-project-detail.js.map
