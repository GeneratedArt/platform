function r(e){return e.replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#39;")}function v(e,n){let t;return((...a)=>{t!==void 0&&clearTimeout(t),t=setTimeout(()=>e(...a),n)})}function j(e){return`
    <a class="ga-search-hit" href="/p/?id=${e.id}">
      <h4>${r(e.title)}</h4>
      ${e.description?`<p>${r(e.description.slice(0,160))}</p>`:""}
      <p class="ga-search-meta">
        ${e.owner_handle?`@${r(e.owner_handle)}`:""}
        \xB7 ${r(e.status)}
      </p>
    </a>
  `}function L(e){let n=e.display_name||e.handle;return`
    <a class="ga-search-hit" href="/@${r(e.handle)}/">
      <h4>${r(n)}</h4>
      <p class="ga-search-meta">@${r(e.handle)}</p>
      ${e.bio?`<p>${r(e.bio.slice(0,160))}</p>`:""}
    </a>
  `}function y(e){return`
    <a class="ga-search-hit" href="/briefs/${e.id}/">
      <h4>${r(e.title)}</h4>
      <p>${r(e.body_snippet)}</p>
      <p class="ga-search-meta">brief \xB7 ${r(e.status)}${e.author_handle?` \xB7 @${r(e.author_handle)}`:""}</p>
    </a>
  `}var H={mount(e){let{apiBase:n,rootEl:t}=e;if(!t)return;t.innerHTML=`
      <form class="ga-search-form" role="search" autocomplete="off">
        <input id="ga-search-input" type="search" placeholder="Search projects, artists, briefs\u2026"
               class="form-control rounded-0" aria-label="Search query" />
      </form>
      <div class="ga-search-results">
        <section data-group="projects">
          <h3>Projects</h3>
          <div class="ga-search-list" id="ga-search-projects"></div>
        </section>
        <section data-group="artists">
          <h3>Artists</h3>
          <div class="ga-search-list" id="ga-search-artists"></div>
        </section>
        <section data-group="briefs">
          <h3>Briefs</h3>
          <div class="ga-search-list" id="ga-search-briefs"></div>
        </section>
      </div>
      <p class="ga-search-status small text-muted" id="ga-search-status"></p>
    `;let a=t.querySelector("#ga-search-input"),p=t.querySelector("#ga-search-projects"),f=t.querySelector("#ga-search-artists"),m=t.querySelector("#ga-search-briefs"),i=t.querySelector("#ga-search-status"),o=new URLSearchParams(location.search).get("q")||"";o&&(a.value=o);async function h(c){let l=c.trim(),u=new URL(location.href);if(l?u.searchParams.set("q",l):u.searchParams.delete("q"),history.replaceState(null,"",u.toString()),!l){p.innerHTML="",f.innerHTML="",m.innerHTML="",i.textContent="Type to search.";return}i.textContent="Searching\u2026";let S=new URL(`${n}/v1/search`);S.searchParams.set("q",l);try{let d=performance.now(),g=await fetch(S.toString());if(!g.ok)throw new Error(`HTTP ${g.status}`);let s=await g.json(),$=Math.round(performance.now()-d);p.innerHTML=s.projects.length>0?s.projects.map(j).join(""):'<p class="text-muted small">No matching projects.</p>',f.innerHTML=s.artists.length>0?s.artists.map(L).join(""):'<p class="text-muted small">No matching artists.</p>',m.innerHTML=s.briefs.length>0?s.briefs.map(y).join(""):'<p class="text-muted small">No matching briefs.</p>';let b=s.projects.length+s.artists.length+s.briefs.length;i.textContent=`${b} result${b===1?"":"s"} in ${$} ms`}catch(d){i.textContent=`Search failed: ${d.message}`}}let T=v(c=>h(c),200);a.addEventListener("input",()=>T(a.value)),t.querySelector(".ga-search-form")?.addEventListener("submit",c=>{c.preventDefault(),h(a.value)}),o?h(o):i.textContent="Type to search.",a.focus()}};window.GASearch=H;var w=H;export{w as default};
//# sourceMappingURL=ga-search.js.map
