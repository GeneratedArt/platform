function i(e){return e.replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#39;")}function y(e){let r=Math.max(0,Math.floor(Date.now()/1e3-e));return r<60?"just now":r<3600?`${Math.floor(r/60)}m ago`:r<86400?`${Math.floor(r/3600)}h ago`:`${Math.floor(r/86400)}d ago`}function $(e){try{let r=new URL(e,location.origin);if(!r.pathname.includes("/v1/captures/"))return"";let n=o=>(r.searchParams.set("w",String(o)),`${r.toString()} ${o}w`);return[n(240),n(480),n(800)].join(", ")}catch{return""}}function E(e,r){let n;if(e.cover_url){let g=$(e.cover_url);n=`<img src="${i(e.cover_url)}"${g?` srcset="${i(g)}" sizes="(max-width: 600px) 100vw, 320px"`:""} alt="" loading="lazy" />`}else n='<span class="ga-explore-cover-empty">No capture yet</span>';let o=e.owner.handle?`<span class="ga-explore-author">@${i(e.owner.handle)}</span>`:"",t=e.mint_count>0?`<span class="ga-explore-mints">${e.mint_count} mint${e.mint_count===1?"":"s"}</span>`:"",b=`/p/?id=${e.id}`;return`
    <a class="ga-explore-card" href="${i(b)}">
      <div class="ga-explore-cover">${n}</div>
      <div class="ga-explore-card-body">
        <h3>${i(e.title)}</h3>
        <p class="ga-explore-card-meta">${o} \xB7 ${i(y(e.created_at))}</p>
        ${t?`<p class="ga-explore-card-mints">${t}</p>`:""}
      </div>
    </a>
  `}var h={mount(e){let{apiBase:r,rootEl:n}=e;if(!n)return;n.innerHTML=`
      <div class="ga-explore-tabs" role="tablist">
        <button type="button" class="ga-explore-tab is-active" role="tab" data-tab="recent">Recent</button>
        <button type="button" class="ga-explore-tab" role="tab" data-tab="trending">Trending</button>
        <button type="button" class="ga-explore-tab" role="tab" data-tab="featured">Featured</button>
        <button type="button" class="ga-explore-tab" role="tab" data-tab="galleries">Galleries</button>
      </div>
      <div class="ga-explore-grid" id="ga-explore-grid"></div>
      <div class="ga-explore-status text-center py-6 text-muted small" id="ga-explore-status">Loading\u2026</div>
      <div class="ga-explore-sentinel" aria-hidden="true"></div>
    `;let o=n.querySelector("#ga-explore-grid"),t=n.querySelector("#ga-explore-status"),b=n.querySelector(".ga-explore-sentinel"),g=n.querySelectorAll(".ga-explore-tab"),d="recent",u=null,m=!1,p=!1,f=new URLSearchParams(location.search).get("tab");(f==="trending"||f==="featured"||f==="galleries")&&(d=f,g.forEach(l=>l.classList.toggle("is-active",l.dataset.tab===d)));async function x(l){if(!m&&!(!l&&p)){m=!0,l?(o.innerHTML="",u=null,p=!1,t.textContent="Loading\u2026"):t.textContent="Loading more\u2026";try{if(d==="galleries"){let a=new URL(`${r}/v1/galleries`);u&&a.searchParams.set("before",u);let s=await fetch(a.toString());if(!s.ok)throw new Error(`HTTP ${s.status}`);let c=await s.json();c.galleries.length===0&&l?t.textContent="No galleries yet.":(o.insertAdjacentHTML("beforeend",c.galleries.map(_).join("")),u=c.next_before!==null?String(c.next_before):null,u?t.textContent="":(p=!0,t.textContent=o.children.length===0?t.textContent:"End of feed."))}else{let a=new URL(`${r}/v1/explore`);a.searchParams.set("tab",d),u&&a.searchParams.set("cursor",u);let s=await fetch(a.toString());if(!s.ok)throw new Error(`HTTP ${s.status}`);let c=await s.json();c.cards.length===0&&l?t.textContent=d==="featured"?"No featured projects yet.":d==="trending"?"No trending activity yet \u2014 check back after a few mints.":"No projects yet.":(o.insertAdjacentHTML("beforeend",c.cards.map(v=>E(v,r)).join("")),u=c.next_cursor,u?t.textContent="":(p=!0,t.textContent=o.children.length===0?t.textContent:"End of feed."))}}catch(a){t.textContent=`Failed to load (${a.message}). Tap to retry.`,t.style.cursor="pointer",t.onclick=()=>{t.style.cursor="",t.onclick=null,x(l)}}finally{m=!1}}}g.forEach(l=>{l.addEventListener("click",()=>{let a=l.dataset.tab;if(a===d)return;d=a,g.forEach(c=>c.classList.toggle("is-active",c===l));let s=new URL(location.href);s.searchParams.set("tab",a),history.replaceState(null,"",s.toString()),x(!0)})}),"IntersectionObserver"in window&&new IntersectionObserver(a=>{for(let s of a)s.isIntersecting&&x(!1)},{rootMargin:"400px 0px"}).observe(b),x(!0)}};function _(e){let r=e.cover_url?`<img src="${i(e.cover_url)}" alt="" loading="lazy" />`:'<span class="ga-explore-cover-empty">No cover</span>',n=e.curator?.handle?`Curated by @${i(e.curator.handle)}`:"Uncurated",o=`${e.project_count} ${e.project_count===1?"project":"projects"}`,t=e.location?i(e.location):"";return`
    <a class="ga-explore-card" href="/galleries/${i(e.slug)}/">
      <div class="ga-explore-cover">${r}</div>
      <div class="ga-explore-card-body">
        <h3>${i(e.title)}</h3>
        <p class="ga-explore-card-meta">${i(n)}${t?` \xB7 ${t}`:""}</p>
        <p class="ga-explore-card-mints"><span class="ga-explore-mints">${o}</span></p>
      </div>
    </a>
  `}window.GAExplore=h;var w=h;export{w as default};
//# sourceMappingURL=ga-explore.js.map
