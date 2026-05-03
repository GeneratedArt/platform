function s(e){return e.replace(/[&<>"']/g,r=>r==="&"?"&amp;":r==="<"?"&lt;":r===">"?"&gt;":r==='"'?"&quot;":"&#39;")}function h(e){try{return new Date(e*1e3).toLocaleDateString(void 0,{year:"numeric",month:"short",day:"numeric"})}catch{return""}}function T(e,r){return!e&&!r?"":e&&r?`${h(e)} \u2013 ${h(r)}`:h(e??r)}function x(e){let l=s(e.replace(/\r\n?/g,`
`)).split(`
`),a=[],t=0,n=o=>(o=o.replace(/`([^`\n]+)`/g,(i,c)=>`<code>${c}</code>`),o=o.replace(/\*\*([^*\n]+)\*\*/g,"<strong>$1</strong>"),o=o.replace(/__([^_\n]+)__/g,"<strong>$1</strong>"),o=o.replace(/(^|\W)\*([^*\n]+)\*(?!\*)/g,"$1<em>$2</em>"),o=o.replace(/(^|\W)_([^_\n]+)_(?!_)/g,"$1<em>$2</em>"),o=o.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,(i,c,u)=>`<a href="${u}" rel="noopener nofollow ugc" target="_blank">${c}</a>`),o);for(;t<l.length;){let o=l[t];if(/^\s*$/.test(o)){t++;continue}let i=/^(#{1,3})\s+(.*)$/.exec(o);if(i){let u=i[1].length+2;a.push(`<h${u}>${n(i[2])}</h${u}>`),t++;continue}if(/^&gt;\s?/.test(o)){let u=[];for(;t<l.length&&/^&gt;\s?/.test(l[t]);)u.push(n(l[t].replace(/^&gt;\s?/,""))),t++;a.push(`<blockquote>${u.join("<br>")}</blockquote>`);continue}if(/^[-*]\s+/.test(o)){let u=[];for(;t<l.length&&/^[-*]\s+/.test(l[t]);)u.push(`<li>${n(l[t].replace(/^[-*]\s+/,""))}</li>`),t++;a.push(`<ul>${u.join("")}</ul>`);continue}if(/^\d+\.\s+/.test(o)){let u=[];for(;t<l.length&&/^\d+\.\s+/.test(l[t]);)u.push(`<li>${n(l[t].replace(/^\d+\.\s+/,""))}</li>`),t++;a.push(`<ol>${u.join("")}</ol>`);continue}if(/^---+\s*$/.test(o)){a.push("<hr>"),t++;continue}let c=[];for(;t<l.length&&l[t].trim()!==""&&!/^(#{1,3}\s|&gt;\s?|[-*]\s+|\d+\.\s+|---+\s*$)/.test(l[t]);)c.push(n(l[t])),t++;a.push(`<p>${c.join("<br>")}</p>`)}return a.join(`
`)}async function y(e,r){let l=await fetch(`${e}${r}`,{credentials:"include"});return l.ok?await l.json():{__status:l.status}}async function v(e,r,l,a){let t=await fetch(`${e}${r}`,{method:l,credentials:"include",headers:{"Content-Type":"application/json"},body:JSON.stringify(a)}),n=await t.json().catch(()=>({}));return t.ok?{ok:!0,data:n}:{ok:!1,status:t.status,data:n}}function b(e){return typeof e=="object"&&e!==null&&"__status"in e}function H(e,r){return`https://staticmap.openstreetmap.de/staticmap.php?center=${e},${r}&zoom=13&size=600x300&maptype=mapnik&markers=${e},${r},red-pushpin`}function S(e,r){return`https://www.openstreetmap.org/?mlat=${e}&mlon=${r}#map=14/${e}/${r}`}function P(e){return`/p/?id=${e.project_id}`}async function k(e){e.rootEl.innerHTML=`
    <header class="mb-4">
      <h1 class="h2 mb-2">Galleries</h1>
      <p class="text-muted small mb-3">
        Curator-grouped exhibitions. Verified curators can
        <a href="/galleries/new/">create a gallery</a>; everyone else can
        <a href="/briefs/new/?industry=gallery">request curator access</a>.
      </p>
    </header>
    <div id="ga-galleries-list" aria-busy="true">
      <p class="text-muted small">Loading galleries\u2026</p>
    </div>
  `;let r=e.rootEl.querySelector("#ga-galleries-list");if(!r)return;let l=await y(e.apiBase,"/v1/galleries");if(b(l)){r.innerHTML=`<p class="text-danger small">Couldn't load galleries (HTTP ${l.__status}).</p>`,r.removeAttribute("aria-busy");return}if(l.galleries.length===0){r.innerHTML=`
      <div class="ga-empty text-center py-10">
        <p class="text-muted small mb-3">No galleries yet.</p>
        <a href="/galleries/new/" class="btn btn-accent rounded-0">Create the first gallery</a>
      </div>
    `,r.removeAttribute("aria-busy");return}r.innerHTML=`<div class="ga-galleries-grid">${l.galleries.map(B).join("")}</div>`,r.removeAttribute("aria-busy")}function B(e){let r=e.cover_url?`<img src="${s(e.cover_url)}" alt="" loading="lazy" />`:'<span class="ga-gallery-cover-empty">No cover</span>',l=T(e.starts_at,e.ends_at),t=[e.location?s(e.location):"",l].filter(Boolean).join(" \xB7 "),n=e.curator?`Curated by <a href="/@${s(e.curator.handle)}/">@${s(e.curator.handle)}</a>`:"Uncurated";return`
    <a class="ga-gallery-card" href="/galleries/${s(e.slug)}/">
      <div class="ga-gallery-cover">${r}</div>
      <div class="ga-gallery-card-body">
        <h3 class="h5 mb-1">${s(e.title)}</h3>
        <p class="ga-gallery-meta">${n}</p>
        ${t?`<p class="ga-gallery-meta text-muted">${t}</p>`:""}
        <p class="ga-gallery-meta text-muted">${e.project_count} ${e.project_count===1?"project":"projects"}</p>
      </div>
    </a>
  `}async function D(e){let l=(new URLSearchParams(window.location.search).get("slug")||"").toLowerCase();if(!/^[a-z0-9-]{1,80}$/.test(l)){e.rootEl.innerHTML='<p class="text-danger small">Missing or invalid gallery slug.</p>';return}let a=await y(e.apiBase,`/v1/galleries/${encodeURIComponent(l)}`);if(b(a)){e.rootEl.innerHTML=a.__status===404?'<div class="text-center py-10"><h1 class="h3 mb-3">Gallery not found</h1><p class="text-muted"><a href="/galleries/">All galleries</a></p></div>':`<p class="text-danger small">Couldn't load (HTTP ${a.__status}).</p>`;return}let t=a.gallery,n=T(t.starts_at,t.ends_at),o=t.cover_url?`<img class="ga-gallery-detail-cover" src="${s(t.cover_url)}" alt="${s(t.title)}" />`:"",i=t.curator?`
    <p class="ga-gallery-meta">
      Curated by <a href="/@${s(t.curator.handle)}/">${s(t.curator.display_name||"@"+t.curator.handle)}</a>
    </p>`:"",c="";if(t.location||n){let m=[t.location?s(t.location):"",n].filter(Boolean).join(" \xB7 "),p="";if(t.lat!==null&&t.lon!==null){let d=H(t.lat,t.lon),g=S(t.lat,t.lon);p=`
        <a class="ga-gallery-map" href="${s(g)}" target="_blank" rel="noopener">
          <img src="${s(d)}" alt="Map of ${s(t.location||"venue")}"
               onerror="this.parentElement.innerHTML='View on OpenStreetMap \u2197';this.parentElement.classList.add('ga-gallery-map-fallback');" />
        </a>`}c=`
      <section class="ga-gallery-physical mt-4">
        <h2 class="h5 mb-2">Physical show</h2>
        <p class="ga-gallery-meta">${m}</p>
        ${p}
      </section>
    `}let u=t.projects.length===0?'<p class="text-muted small">No projects in this gallery yet.</p>':`<div class="ga-gallery-projects-grid">
        ${t.projects.map(q).join("")}
      </div>`;if(e.rootEl.innerHTML=`
    <header class="mb-4">
      <p class="ga-gallery-meta"><a href="/galleries/">\u2190 All galleries</a></p>
      <h1 class="h2 mb-2">${s(t.title)}</h1>
      ${i}
      ${t.description?`<p class="text-muted">${s(t.description)}</p>`:""}
    </header>
    ${o}
    <div id="ga-gallery-actions" class="mt-3 d-none">
      <a class="btn btn-sm btn-outline-primary rounded-0" href="/galleries/${s(t.slug)}/edit/">Edit gallery</a>
    </div>
    ${t.body_md?'<section class="ga-gallery-body mt-4"></section>':""}
    ${c}
    <section class="mt-6">
      <h2 class="h5 mb-3">Projects</h2>
      ${u}
    </section>
  `,t.body_md){let m=e.rootEl.querySelector(".ga-gallery-body");m.innerHTML=x(t.body_md)}try{let m=await y(e.apiBase,"/v1/me");!b(m)&&t.curator&&m.user.id===t.curator.id&&e.rootEl.querySelector("#ga-gallery-actions")?.classList.remove("d-none")}catch{}}function q(e){let r=e.cover_url?`<img src="${s(e.cover_url)}" alt="" loading="lazy" />`:'<span class="ga-gallery-project-empty">No capture</span>';return`
    <a class="ga-gallery-project-card" href="${s(P(e))}">
      <div class="ga-gallery-project-cover">${r}</div>
      <div class="ga-gallery-project-body">
        <h3 class="h6 mb-0">${s(e.title)}</h3>
        <p class="ga-gallery-meta text-muted">@${s(e.owner_handle)}</p>
      </div>
    </a>
  `}function _(e){if(!e)return"";try{return new Date(e*1e3).toISOString().slice(0,10)}catch{return""}}function L(e){let r=a=>(e.rootEl.querySelector(a)?.value||"").trim(),l=e.rootEl.querySelector("#ga-gallery-cover-url");return{title:r("#ga-gallery-title"),description:r("#ga-gallery-description"),bodyMd:r("#ga-gallery-body"),coverUrl:(l?.value||"").trim()||null,location:r("#ga-gallery-location"),lat:r("#ga-gallery-lat"),lon:r("#ga-gallery-lon"),startsDate:r("#ga-gallery-starts"),endsDate:r("#ga-gallery-ends"),projects:[]}}function w(e,r){if(!e)return null;let l=Date.parse(`${e}T${r?"23:59:59":"00:00:00"}Z`);return Number.isFinite(l)?Math.floor(l/1e3):null}function E(e){return{title:e.title,description:e.description||null,body_md:e.bodyMd||null,cover_url:e.coverUrl,location:e.location||null,lat:e.lat?parseFloat(e.lat):null,lon:e.lon?parseFloat(e.lon):null,starts_at:w(e.startsDate,!1),ends_at:w(e.endsDate,!0)}}function j(e,r){return`
    <div id="ga-gallery-error" class="alert alert-danger d-none small" role="alert"></div>
    <form id="ga-gallery-form">
      <div class="mb-4">
        <label class="form-label small" for="ga-gallery-title">Title</label>
        <input type="text" id="ga-gallery-title" class="form-control rounded-0" maxlength="120" required value="${s(e.title||"")}" />
      </div>
      <div class="mb-4">
        <label class="form-label small" for="ga-gallery-description">Short description</label>
        <input type="text" id="ga-gallery-description" class="form-control rounded-0" maxlength="280" value="${s(e.description||"")}" />
        <p class="form-text small text-muted">One line shown on the listing card.</p>
      </div>
      <div class="mb-4">
        <label class="form-label small" for="ga-gallery-body">Body (markdown)</label>
        <textarea id="ga-gallery-body" class="form-control rounded-0" rows="10" maxlength="10000">${s(e.bodyMd||"")}</textarea>
      </div>
      <div class="mb-4">
        <label class="form-label small" for="ga-gallery-cover-file">Cover image (PNG, optional)</label>
        <input type="file" id="ga-gallery-cover-file" class="form-control rounded-0" accept="image/png" />
        <input type="hidden" id="ga-gallery-cover-url" value="${s(e.coverUrl||"")}" />
        <div id="ga-gallery-cover-preview" class="mt-2 small text-muted">
          ${e.coverPreview?`<img src="${s(e.coverPreview)}" style="max-width:240px;" />`:""}
        </div>
      </div>
      <fieldset class="mb-4">
        <legend class="h6">Physical show (optional)</legend>
        <div class="mb-3">
          <label class="form-label small" for="ga-gallery-location">Location</label>
          <input type="text" id="ga-gallery-location" class="form-control rounded-0" maxlength="120" placeholder="Geneva, CH" value="${s(e.location||"")}" />
        </div>
        <div class="row gx-3">
          <div class="col-6 col-md-3 mb-3">
            <label class="form-label small" for="ga-gallery-lat">Latitude</label>
            <input type="text" id="ga-gallery-lat" class="form-control rounded-0" placeholder="46.2044" value="${s(e.lat||"")}" />
          </div>
          <div class="col-6 col-md-3 mb-3">
            <label class="form-label small" for="ga-gallery-lon">Longitude</label>
            <input type="text" id="ga-gallery-lon" class="form-control rounded-0" placeholder="6.1432" value="${s(e.lon||"")}" />
          </div>
          <div class="col-6 col-md-3 mb-3">
            <label class="form-label small" for="ga-gallery-starts">Starts</label>
            <input type="date" id="ga-gallery-starts" class="form-control rounded-0" value="${s(e.startsDate||"")}" />
          </div>
          <div class="col-6 col-md-3 mb-3">
            <label class="form-label small" for="ga-gallery-ends">Ends</label>
            <input type="date" id="ga-gallery-ends" class="form-control rounded-0" value="${s(e.endsDate||"")}" />
          </div>
        </div>
        <p class="form-text small text-muted mb-0">Both lat & lon must be set together. Leave blank to skip the map.</p>
      </fieldset>
      ${r==="edit"?`
        <fieldset class="mb-4">
          <legend class="h6">Projects</legend>
          <div id="ga-gallery-current-projects" class="small mb-3"></div>
          <div class="d-flex gap-2 align-items-center">
            <input type="number" min="1" id="ga-gallery-add-id" class="form-control rounded-0" style="max-width:160px;" placeholder="Project id" />
            <button type="button" id="ga-gallery-add-btn" class="btn btn-sm btn-outline-primary rounded-0">Add</button>
          </div>
          <p class="form-text small text-muted">Paste a project id (visible on /p/?id=N). The project must be Published or Minted.</p>
        </fieldset>`:""}
      <button type="submit" class="btn btn-accent rounded-0" id="ga-gallery-submit">${r==="new"?"Create gallery":"Save changes"}</button>
    </form>
  `}async function G(e,r){if(!r.type.startsWith("image/png"))return null;let l=await r.arrayBuffer(),a=new Uint8Array(l),t="",n=32768;for(let c=0;c<a.length;c+=n)t+=String.fromCharCode.apply(null,Array.from(a.subarray(c,c+n)));let o=`data:image/png;base64,${btoa(t)}`,i=await v(e,"/v1/galleries/cover","POST",{data_url:o});return i.ok?i.data.cover.url:null}function C(e){let r=e.rootEl.querySelector("#ga-gallery-cover-file"),l=e.rootEl.querySelector("#ga-gallery-cover-url"),a=e.rootEl.querySelector("#ga-gallery-cover-preview");!r||!l||!a||r.addEventListener("change",async()=>{let t=r.files?.[0];if(!t)return;a.textContent="Uploading\u2026";let n=await G(e.apiBase,t);if(!n){a.innerHTML='<span class="text-danger">Upload failed (PNG only, \u22645 MB).</span>';return}l.value=n,a.innerHTML=`<img src="${s(n)}" style="max-width:240px;" />`})}async function I(e){let r=await y(e.apiBase,"/v1/me");if(b(r)){e.rootEl.innerHTML=`
      <div class="text-center py-10">
        <h1 class="h3 mb-3">Sign in to create a gallery.</h1>
        <a href="/connect/" class="btn btn-accent rounded-0">Connect wallet</a>
      </div>`;return}if(!r.user.is_curator){e.rootEl.innerHTML=`
      <div class="text-center py-10">
        <h1 class="h3 mb-2">Curator access required</h1>
        <p class="text-muted mb-4">
          Galleries are created by verified curators. Open a brief in the
          <code>gallery</code> industry to request access \u2014 we'll flip the
          flag manually for v1.
        </p>
        <a href="/briefs/new/?industry=gallery" class="btn btn-accent rounded-0">Request curator access</a>
      </div>`;return}e.rootEl.innerHTML=`
    <header class="mb-4">
      <h1 class="h2 mb-1">New gallery</h1>
      <p class="small text-muted mb-0">
        Curating as <a href="/@${s(r.user.handle)}/" class="ga-mono">@${s(r.user.handle)}</a>.
        After creating, you can attach projects from the gallery's edit page.
      </p>
    </header>
    ${j({},"new")}
  `,C(e);let l=e.rootEl.querySelector("#ga-gallery-form"),a=e.rootEl.querySelector("#ga-gallery-error"),t=e.rootEl.querySelector("#ga-gallery-submit");l.addEventListener("submit",async n=>{n.preventDefault(),a.classList.add("d-none"),t.disabled=!0;let o=L(e);if(!o.title){a.textContent="Title is required.",a.classList.remove("d-none"),t.disabled=!1;return}let i=await v(e.apiBase,"/v1/galleries","POST",E(o));if(!i.ok){let c=i.data&&typeof i.data=="object"&&"error"in i.data?String(i.data.error):`HTTP ${i.status}`;a.textContent=`Couldn't create (${c}).`,a.classList.remove("d-none"),t.disabled=!1;return}window.location.href=`/galleries/${i.data.gallery.slug}/edit/`})}async function U(e){let l=(new URLSearchParams(window.location.search).get("slug")||"").toLowerCase();if(!/^[a-z0-9-]{1,80}$/.test(l)){e.rootEl.innerHTML='<p class="text-danger small">Missing or invalid gallery slug.</p>';return}let[a,t]=await Promise.all([y(e.apiBase,"/v1/me"),y(e.apiBase,`/v1/galleries/${encodeURIComponent(l)}`)]);if(b(a)){e.rootEl.innerHTML='<div class="text-center py-10"><h1 class="h3 mb-3">Sign in to edit.</h1><a href="/connect/" class="btn btn-accent rounded-0">Connect wallet</a></div>';return}if(b(t)){e.rootEl.innerHTML=`<p class="text-danger small">Couldn't load gallery (HTTP ${t.__status}).</p>`;return}let n=t.gallery;if(!n.curator||n.curator.id!==a.user.id){e.rootEl.innerHTML='<div class="text-center py-10"><h1 class="h3 mb-3">Not your gallery</h1><p class="text-muted">Only the curator who created a gallery can edit it.</p></div>';return}e.rootEl.innerHTML=`
    <header class="mb-4">
      <p class="small mb-2"><a href="/galleries/${s(n.slug)}/">\u2190 View public page</a></p>
      <h1 class="h2 mb-1">Edit gallery</h1>
    </header>
    ${j({title:n.title,description:n.description||"",bodyMd:n.body_md||"",coverUrl:n.cover_url||null,location:n.location||"",lat:n.lat!==null?String(n.lat):"",lon:n.lon!==null?String(n.lon):"",startsDate:_(n.starts_at),endsDate:_(n.ends_at),coverPreview:n.cover_url||null},"edit")}
  `,C(e),$(e,n);let o=e.rootEl.querySelector("#ga-gallery-form"),i=e.rootEl.querySelector("#ga-gallery-error"),c=e.rootEl.querySelector("#ga-gallery-submit");o.addEventListener("submit",async p=>{p.preventDefault(),i.classList.add("d-none"),c.disabled=!0;let d=L(e);if(!d.title){i.textContent="Title is required.",i.classList.remove("d-none"),c.disabled=!1;return}let g=await v(e.apiBase,`/v1/galleries/${encodeURIComponent(n.slug)}`,"PATCH",E(d));if(!g.ok){let f=g.data&&typeof g.data=="object"&&"error"in g.data?String(g.data.error):`HTTP ${g.status}`;i.textContent=`Couldn't save (${f}).`,i.classList.remove("d-none"),c.disabled=!1;return}c.textContent="Saved",setTimeout(()=>{c.textContent="Save changes",c.disabled=!1},1200)});let u=e.rootEl.querySelector("#ga-gallery-add-btn"),m=e.rootEl.querySelector("#ga-gallery-add-id");u?.addEventListener("click",async()=>{let p=parseInt(m?.value||"",10);if(!Number.isFinite(p)||p<1)return;u.disabled=!0;let d=await v(e.apiBase,`/v1/galleries/${encodeURIComponent(n.slug)}/projects`,"POST",{project_id:p,action:"add"});if(u.disabled=!1,!d.ok){let f=d.data&&typeof d.data=="object"&&"error"in d.data?String(d.data.error):`HTTP ${d.status}`;alert(`Couldn't add: ${f}`);return}m&&(m.value="");let g=await y(e.apiBase,`/v1/galleries/${encodeURIComponent(n.slug)}`);b(g)||$(e,g.gallery)})}function $(e,r){let l=e.rootEl.querySelector("#ga-gallery-current-projects");if(l){if(r.projects.length===0){l.innerHTML='<p class="text-muted small mb-2">No projects yet.</p>';return}l.innerHTML=`
    <ul class="list-unstyled mb-2">
      ${r.projects.map(a=>`
        <li class="d-flex justify-content-between align-items-center py-1" style="border-bottom: 1px dashed var(--ga-rule);">
          <span>
            <a href="/p/?id=${a.project_id}">${s(a.title)}</a>
            <span class="text-muted small">\xB7 @${s(a.owner_handle)} \xB7 #${a.project_id}</span>
          </span>
          <button type="button" class="btn btn-sm btn-link text-danger p-0" data-remove="${a.project_id}">Remove</button>
        </li>`).join("")}
    </ul>
  `,l.querySelectorAll("[data-remove]").forEach(a=>{a.addEventListener("click",async()=>{let t=parseInt(a.getAttribute("data-remove")||"",10);if(!t)return;if(a.disabled=!0,a.textContent="Removing\u2026",!(await v(e.apiBase,`/v1/galleries/${encodeURIComponent(r.slug)}/projects`,"POST",{project_id:t,action:"remove"})).ok){a.disabled=!1,a.textContent="Remove";return}let o=await y(e.apiBase,`/v1/galleries/${encodeURIComponent(r.slug)}`);b(o)||$(e,o.gallery)})})}}var M={mountList:k,mountDetail:D,mountNew:I,mountEdit:U,_renderMarkdown:x};window.GAGalleries=M;var A=M;export{A as default};
//# sourceMappingURL=ga-galleries.js.map
