function d(e){return e.replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#39;")}function y(e){let t=Math.max(0,Math.floor(Date.now()/1e3-e));return t<60?"just now":t<3600?`${Math.floor(t/60)}m ago`:t<86400?`${Math.floor(t/3600)}h ago`:`${Math.floor(t/86400)}d ago`}function E(e){try{let t=new URL(e,location.origin);if(!t.pathname.includes("/v1/captures/"))return"";let r=l=>(t.searchParams.set("w",String(l)),`${t.toString()} ${l}w`);return[r(240),r(480),r(800)].join(", ")}catch{return""}}function w(e,t){let r;if(e.cover_url){let c=E(e.cover_url);r=`<img src="${d(e.cover_url)}"${c?` srcset="${d(c)}" sizes="(max-width: 600px) 100vw, 320px"`:""} alt="" loading="lazy" />`}else r='<span class="ga-explore-cover-empty">No capture yet</span>';let l=e.owner.handle?`<span class="ga-explore-author">@${d(e.owner.handle)}</span>`:"",n=e.mint_count>0?`<span class="ga-explore-mints">${e.mint_count} mint${e.mint_count===1?"":"s"}</span>`:"",f=`/p/?id=${e.id}`;return`
    <a class="ga-explore-card" href="${d(f)}">
      <div class="ga-explore-cover">${r}</div>
      <div class="ga-explore-card-body">
        <h3>${d(e.title)}</h3>
        <p class="ga-explore-card-meta">${l} \xB7 ${d(y(e.created_at))}</p>
        ${n?`<p class="ga-explore-card-mints">${n}</p>`:""}
      </div>
    </a>
  `}var h={mount(e){let{apiBase:t,rootEl:r}=e;if(!r)return;r.innerHTML=`
      <div class="ga-explore-tabs" role="tablist">
        <button type="button" class="ga-explore-tab is-active" role="tab" data-tab="recent">Recent</button>
        <button type="button" class="ga-explore-tab" role="tab" data-tab="trending">Trending</button>
        <button type="button" class="ga-explore-tab" role="tab" data-tab="featured">Featured</button>
      </div>
      <div class="ga-explore-grid" id="ga-explore-grid"></div>
      <div class="ga-explore-status text-center py-6 text-muted small" id="ga-explore-status">Loading\u2026</div>
      <div class="ga-explore-sentinel" aria-hidden="true"></div>
    `;let l=r.querySelector("#ga-explore-grid"),n=r.querySelector("#ga-explore-status"),f=r.querySelector(".ga-explore-sentinel"),c=r.querySelectorAll(".ga-explore-tab"),i="recent",g=null,x=!1,m=!1,b=new URLSearchParams(location.search).get("tab");(b==="trending"||b==="featured")&&(i=b,c.forEach(a=>a.classList.toggle("is-active",a.dataset.tab===i)));async function p(a){if(x||!a&&m)return;x=!0,a?(l.innerHTML="",g=null,m=!1,n.textContent="Loading\u2026"):n.textContent="Loading more\u2026";let s=new URL(`${t}/v1/explore`);s.searchParams.set("tab",i),g&&s.searchParams.set("cursor",g);try{let o=await fetch(s.toString());if(!o.ok)throw new Error(`HTTP ${o.status}`);let u=await o.json();u.cards.length===0&&a?n.textContent=i==="featured"?"No featured projects yet.":i==="trending"?"No trending activity yet \u2014 check back after a few mints.":"No projects yet.":(l.insertAdjacentHTML("beforeend",u.cards.map(v=>w(v,t)).join("")),g=u.next_cursor,g?n.textContent="":(m=!0,n.textContent=l.children.length===0?n.textContent:"End of feed."))}catch(o){n.textContent=`Failed to load (${o.message}). Tap to retry.`,n.style.cursor="pointer",n.onclick=()=>{n.style.cursor="",n.onclick=null,p(a)}}finally{x=!1}}c.forEach(a=>{a.addEventListener("click",()=>{let s=a.dataset.tab;if(s===i)return;i=s,c.forEach(u=>u.classList.toggle("is-active",u===a));let o=new URL(location.href);o.searchParams.set("tab",s),history.replaceState(null,"",o.toString()),p(!0)})}),"IntersectionObserver"in window&&new IntersectionObserver(s=>{for(let o of s)o.isIntersecting&&p(!1)},{rootMargin:"400px 0px"}).observe(f),p(!0)}};window.GAExplore=h;var $=h;export{$ as default};
//# sourceMappingURL=ga-explore.js.map
