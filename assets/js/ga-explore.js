function u(e){return e.replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#39;")}function v(e){let n=Math.max(0,Math.floor(Date.now()/1e3-e));return n<60?"just now":n<3600?`${Math.floor(n/60)}m ago`:n<86400?`${Math.floor(n/3600)}h ago`:`${Math.floor(n/86400)}d ago`}function E(e){let n=e.cover_url?`<img src="${u(e.cover_url)}" alt="" loading="lazy" />`:'<span class="ga-explore-cover-empty">No capture yet</span>',l=e.owner.handle?`<a class="ga-explore-author" href="/@${u(e.owner.handle)}/">@${u(e.owner.handle)}</a>`:"",i=e.mint_count>0?`<span class="ga-explore-mints">${e.mint_count} mint${e.mint_count===1?"":"s"}</span>`:"";return`
    <a class="ga-explore-card" href="/p/?id=${e.id}">
      <div class="ga-explore-cover">${n}</div>
      <div class="ga-explore-card-body">
        <h3>${u(e.title)}</h3>
        <p class="ga-explore-card-meta">${l} \xB7 ${u(v(e.created_at))}</p>
        ${i?`<p class="ga-explore-card-mints">${i}</p>`:""}
      </div>
    </a>
  `}var b={mount(e){let{apiBase:n,rootEl:l}=e;if(!l)return;l.innerHTML=`
      <div class="ga-explore-tabs" role="tablist">
        <button type="button" class="ga-explore-tab is-active" role="tab" data-tab="recent">Recent</button>
        <button type="button" class="ga-explore-tab" role="tab" data-tab="trending">Trending</button>
        <button type="button" class="ga-explore-tab" role="tab" data-tab="featured">Featured</button>
      </div>
      <div class="ga-explore-grid" id="ga-explore-grid"></div>
      <div class="ga-explore-status text-center py-6 text-muted small" id="ga-explore-status">Loading\u2026</div>
      <div class="ga-explore-sentinel" aria-hidden="true"></div>
    `;let i=l.querySelector("#ga-explore-grid"),r=l.querySelector("#ga-explore-status"),h=l.querySelector(".ga-explore-sentinel"),p=l.querySelectorAll(".ga-explore-tab"),s="recent",d=null,f=!1,x=!1,m=new URLSearchParams(location.search).get("tab");(m==="trending"||m==="featured")&&(s=m,p.forEach(t=>t.classList.toggle("is-active",t.dataset.tab===s)));async function g(t){if(f||!t&&x)return;f=!0,t?(i.innerHTML="",d=null,x=!1,r.textContent="Loading\u2026"):r.textContent="Loading more\u2026";let o=new URL(`${n}/v1/explore`);o.searchParams.set("tab",s),d&&o.searchParams.set("cursor",d);try{let a=await fetch(o.toString());if(!a.ok)throw new Error(`HTTP ${a.status}`);let c=await a.json();c.cards.length===0&&t?r.textContent=s==="featured"?"No featured projects yet.":s==="trending"?"No trending activity yet \u2014 check back after a few mints.":"No projects yet.":(i.insertAdjacentHTML("beforeend",c.cards.map(E).join("")),d=c.next_cursor,d?r.textContent="":(x=!0,r.textContent=i.children.length===0?r.textContent:"End of feed."))}catch(a){r.textContent=`Failed to load (${a.message}). Tap to retry.`,r.style.cursor="pointer",r.onclick=()=>{r.style.cursor="",r.onclick=null,g(t)}}finally{f=!1}}p.forEach(t=>{t.addEventListener("click",()=>{let o=t.dataset.tab;if(o===s)return;s=o,p.forEach(c=>c.classList.toggle("is-active",c===t));let a=new URL(location.href);a.searchParams.set("tab",o),history.replaceState(null,"",a.toString()),g(!0)})}),"IntersectionObserver"in window&&new IntersectionObserver(o=>{for(let a of o)a.isIntersecting&&g(!1)},{rootMargin:"400px 0px"}).observe(h),g(!0)}};window.GAExplore=b;var y=b;export{y as default};
//# sourceMappingURL=ga-explore.js.map
