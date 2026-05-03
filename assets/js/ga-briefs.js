var $=["textile","fashion","architecture","product","gallery","collab","other"],f={textile:"Textile",fashion:"Fashion",architecture:"Architecture",product:"Product",gallery:"Gallery",collab:"Collab",other:"Other"};function l(t){return t.replace(/[&<>"']/g,u=>{switch(u){case"&":return"&amp;";case"<":return"&lt;";case">":return"&gt;";case'"':return"&quot;";default:return"&#39;"}})}function h(t){try{return new Date(t*1e3).toLocaleDateString(void 0,{year:"numeric",month:"short",day:"numeric"})}catch{return""}}function T(t){let n=l(t.replace(/\r\n?/g,`
`)).split(`
`),s=[],e=0,o=a=>(a=a.replace(/`([^`\n]+)`/g,(d,r)=>`<code>${r}</code>`),a=a.replace(/\*\*([^*\n]+)\*\*/g,"<strong>$1</strong>"),a=a.replace(/__([^_\n]+)__/g,"<strong>$1</strong>"),a=a.replace(/(^|\W)\*([^*\n]+)\*(?!\*)/g,"$1<em>$2</em>"),a=a.replace(/(^|\W)_([^_\n]+)_(?!_)/g,"$1<em>$2</em>"),a=a.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,(d,r,i)=>`<a href="${i}" rel="noopener nofollow ugc" target="_blank">${r}</a>`),a);for(;e<n.length;){let a=n[e];if(/^\s*$/.test(a)){e++;continue}let d=/^(#{1,3})\s+(.*)$/.exec(a);if(d){let i=d[1].length+2;s.push(`<h${i}>${o(d[2])}</h${i}>`),e++;continue}if(/^&gt;\s?/.test(a)){let i=[];for(;e<n.length&&/^&gt;\s?/.test(n[e]);)i.push(o(n[e].replace(/^&gt;\s?/,""))),e++;s.push(`<blockquote>${i.join("<br>")}</blockquote>`);continue}if(/^[-*]\s+/.test(a)){let i=[];for(;e<n.length&&/^[-*]\s+/.test(n[e]);)i.push(`<li>${o(n[e].replace(/^[-*]\s+/,""))}</li>`),e++;s.push(`<ul>${i.join("")}</ul>`);continue}if(/^\d+\.\s+/.test(a)){let i=[];for(;e<n.length&&/^\d+\.\s+/.test(n[e]);)i.push(`<li>${o(n[e].replace(/^\d+\.\s+/,""))}</li>`),e++;s.push(`<ol>${i.join("")}</ol>`);continue}if(/^---+\s*$/.test(a)){s.push("<hr>"),e++;continue}let r=[];for(;e<n.length&&n[e].trim()!==""&&!/^(#{1,3}\s|&gt;\s?|[-*]\s+|\d+\.\s+|---+\s*$)/.test(n[e]);)r.push(o(n[e])),e++;s.push(`<p>${r.join("<br>")}</p>`)}return s.join(`
`)}async function E(t,u){let n=await fetch(`${t}${u}`,{credentials:"include"});return n.ok?await n.json():{__status:n.status}}async function M(t,u,n){let s=await fetch(`${t}${u}`,{method:"POST",credentials:"include",headers:{"Content-Type":"application/json"},body:JSON.stringify(n)}),e=await s.json().catch(()=>({}));return s.ok?{ok:!0,data:e}:{ok:!1,status:s.status,data:e}}function w(t){return typeof t=="object"&&t!==null&&"__status"in t}async function S(t){let n=new URLSearchParams(window.location.search).get("industry"),s=n&&$.includes(n)?n:"",e=["",...$].map(r=>{let i=r===""?"All":f[r],c=r===s?" ga-chip-active":"",b=r===""?"/briefs/":`/briefs/?industry=${encodeURIComponent(r)}`;return`<a class="ga-chip${c}" href="${b}">${l(i)}</a>`}).join("");t.rootEl.innerHTML=`
    <header class="mb-4">
      <h1 class="h2 mb-2">Briefs</h1>
      <p class="text-muted small mb-3">
        Open commissions and collaboration calls. Sign in to
        <a href="/briefs/new/">post a brief</a>.
      </p>
      <nav class="ga-chips">${e}</nav>
    </header>
    <div id="ga-briefs-list" aria-busy="true">
      <p class="text-muted small">Loading briefs\u2026</p>
    </div>
  `;let o=t.rootEl.querySelector("#ga-briefs-list");if(!o)return;let a=s?`?industry=${encodeURIComponent(s)}`:"",d=await E(t.apiBase,`/v1/briefs${a}`);if(w(d)){o.innerHTML=`<p class="text-danger small">Couldn't load briefs (HTTP ${d.__status}).</p>`,o.removeAttribute("aria-busy");return}if(d.briefs.length===0){o.innerHTML=`
      <div class="ga-empty">
        <p class="text-muted small mb-3">
          ${s?`No open briefs in ${l(f[s])} yet.`:"No open briefs yet."}
        </p>
        <a href="/briefs/new/" class="btn btn-accent rounded-0">Post the first one</a>
      </div>
    `,o.removeAttribute("aria-busy");return}o.innerHTML=d.briefs.map(r=>{let i=l(r.author.handle),c=l(r.author.display_name||r.author.handle),b=l(f[r.industry]||r.industry),p=r.budget?`\xB7 ${l(r.budget)} ETH`:"",y=r.deadline?`\xB7 deadline ${l(h(r.deadline))}`:"";return`
      <article class="ga-brief-card">
        <p class="ga-brief-meta">
          <span class="ga-brief-industry">${b}</span>
          \xB7 <a href="/@${i}/">@${i}</a>
          \xB7 ${l(h(r.created_at))}
          ${p} ${y}
        </p>
        <h2 class="h5 mb-1"><a href="/briefs/${r.id}/">${l(r.title)}</a></h2>
        <p class="text-muted small mb-0">${l(r.body_snippet)}</p>
      </article>
    `}).join(""),o.removeAttribute("aria-busy")}async function x(t){let u=await E(t.apiBase,"/v1/me");if(w(u)){t.rootEl.innerHTML=`
      <div class="text-center py-10">
        <h1 class="h3 mb-3">Sign in to post a brief.</h1>
        <p class="text-muted mb-4">Connect your wallet so others can find and contact you.</p>
        <a href="/connect/" class="btn btn-accent rounded-0">Connect wallet</a>
      </div>
    `;return}let n=$.map(c=>`<option value="${c}">${l(f[c])}</option>`).join("");t.rootEl.innerHTML=`
    <header class="mb-4">
      <h1 class="h2 mb-1">Post a brief</h1>
      <p class="small text-muted mb-0">
        Posting as <a href="/@${l(u.user.handle)}/" class="ga-mono">@${l(u.user.handle)}</a>.
        5 briefs per day. Markdown is supported in the body.
      </p>
    </header>
    <div id="ga-brief-error" class="alert alert-danger d-none small" role="alert"></div>
    <form id="ga-brief-form">
      <div class="mb-4">
        <label class="form-label small" for="ga-brief-industry">Industry</label>
        <select id="ga-brief-industry" class="form-select rounded-0" required>${n}</select>
      </div>
      <div class="mb-4">
        <label class="form-label small" for="ga-brief-title">Title</label>
        <input type="text" id="ga-brief-title" class="form-control rounded-0" maxlength="200" required />
      </div>
      <div class="mb-4">
        <label class="form-label small" for="ga-brief-body">Body (markdown)</label>
        <textarea id="ga-brief-body" class="form-control rounded-0" rows="10" maxlength="10000" required></textarea>
        <p class="form-text small text-muted"><span id="ga-brief-body-count">0</span>/10000</p>
      </div>
      <div class="row gx-3">
        <div class="col-md-6 mb-4">
          <label class="form-label small" for="ga-brief-budget">Budget (ETH, optional)</label>
          <input type="text" id="ga-brief-budget" class="form-control rounded-0" pattern="^\\d+(\\.\\d{1,18})?$" placeholder="0.5" />
        </div>
        <div class="col-md-6 mb-4">
          <label class="form-label small" for="ga-brief-deadline">Deadline (optional)</label>
          <input type="date" id="ga-brief-deadline" class="form-control rounded-0" />
        </div>
      </div>
      <div class="mb-4">
        <details>
          <summary class="small text-muted">Preview</summary>
          <div id="ga-brief-preview" class="ga-brief-body mt-3"></div>
        </details>
      </div>
      <button type="submit" class="btn btn-accent rounded-0" id="ga-brief-submit">Post brief</button>
    </form>
  `;let s=t.rootEl.querySelector("#ga-brief-form"),e=t.rootEl.querySelector("#ga-brief-error"),o=t.rootEl.querySelector("#ga-brief-body"),a=t.rootEl.querySelector("#ga-brief-body-count"),d=t.rootEl.querySelector("#ga-brief-preview"),r=t.rootEl.querySelector("#ga-brief-submit"),i=()=>{a.textContent=String(o.value.length),d.innerHTML=o.value?T(o.value):""};o.addEventListener("input",i),s.addEventListener("submit",async c=>{c.preventDefault(),e.classList.add("d-none"),r.disabled=!0;let b=t.rootEl.querySelector("#ga-brief-industry").value,p=t.rootEl.querySelector("#ga-brief-title").value.trim(),y=o.value.trim(),L=t.rootEl.querySelector("#ga-brief-budget").value.trim(),_=t.rootEl.querySelector("#ga-brief-deadline").value,v={industry:b,title:p,body:y};if(L&&(v.budget=L),_){let g=Date.parse(`${_}T23:59:59Z`);Number.isFinite(g)&&(v.deadline=Math.floor(g/1e3))}let m=await M(t.apiBase,"/v1/briefs",v);if(!m.ok){let g=m.data&&typeof m.data=="object"&&"error"in m.data?String(m.data.error):`HTTP ${m.status}`;e.textContent=`Couldn't post (${g}).`,e.classList.remove("d-none"),r.disabled=!1;return}window.location.href=`/briefs/${m.data.brief.id}/`})}async function B(t){let u=new URLSearchParams(window.location.search),n=parseInt(u.get("id")||"",10);if(!Number.isFinite(n)||n<1){t.rootEl.innerHTML='<p class="text-danger small">Missing brief id.</p>';return}let s=await E(t.apiBase,`/v1/briefs/${n}`);if(w(s)){s.__status===404?t.rootEl.innerHTML=`
        <div class="text-center py-10">
          <h1 class="h3 mb-3">Brief not found</h1>
          <p class="text-muted"><a href="/briefs/">Back to all briefs</a></p>
        </div>
      `:t.rootEl.innerHTML=`<p class="text-danger small">Couldn't load (HTTP ${s.__status}).</p>`;return}let e=s.brief,o=l(e.author.handle),a=l(e.author.display_name||e.author.handle),d=l(f[e.industry]||e.industry),r=e.budget?`<span>Budget \xB7 ${l(e.budget)} ETH</span>`:"",i=e.deadline?`<span>Deadline \xB7 ${l(h(e.deadline))}</span>`:"";t.rootEl.innerHTML=`
    <article class="ga-brief-detail">
      <p class="ga-brief-meta">
        <span class="ga-brief-industry">${d}</span>
        \xB7 By <a href="/@${o}/">${a}</a>
        \xB7 ${l(h(e.created_at))}
      </p>
      <h1 class="h2 mb-3">${l(e.title)}</h1>
      <div class="ga-brief-facts mb-4">${r} ${i}</div>
      <div class="ga-brief-body"></div>
      <hr>
      <div class="ga-brief-apply">
        <button type="button" class="btn btn-accent rounded-0" id="ga-brief-apply">Apply</button>
        <span id="ga-brief-apply-msg" class="small text-muted ms-3 d-none">Application flow coming soon.</span>
      </div>
    </article>
  `;let c=t.rootEl.querySelector(".ga-brief-body");c.innerHTML=T(e.body);let b=t.rootEl.querySelector("#ga-brief-apply"),p=t.rootEl.querySelector("#ga-brief-apply-msg");b.addEventListener("click",()=>{p.classList.remove("d-none"),b.disabled=!0})}var H={mountList:S,mountNew:x,mountDetail:B,_renderMarkdown:T};window.GABriefs=H;var P=H;export{P as default};
//# sourceMappingURL=ga-briefs.js.map
