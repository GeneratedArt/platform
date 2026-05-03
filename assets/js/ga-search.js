function r(e){return e.replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#39;")}function j(e,a){let t;return((...n)=>{t!==void 0&&clearTimeout(t),t=setTimeout(()=>e(...n),a)})}function L(e,a){let t=`/p/?id=${e.id}`;return`
    <a class="ga-search-hit" href="${r(t)}">
      <h4>${r(e.title)}</h4>
      ${e.description?`<p>${r(e.description.slice(0,160))}</p>`:""}
      <p class="ga-search-meta">
        ${e.owner_handle?`@${r(e.owner_handle)}`:""}
        \xB7 ${r(e.status)}
      </p>
    </a>
  `}function y(e){let a=e.display_name||e.handle;return`
    <a class="ga-search-hit" href="/@${r(e.handle)}/">
      <h4>${r(a)}</h4>
      <p class="ga-search-meta">@${r(e.handle)}</p>
      ${e.bio?`<p>${r(e.bio.slice(0,160))}</p>`:""}
    </a>
  `}function w(e){return`
    <a class="ga-search-hit" href="/briefs/${e.id}/">
      <h4>${r(e.title)}</h4>
      <p>${r(e.body_snippet)}</p>
      <p class="ga-search-meta">brief \xB7 ${r(e.status)}${e.author_handle?` \xB7 @${r(e.author_handle)}`:""}</p>
    </a>
  `}var $={mount(e){let{apiBase:a,rootEl:t}=e;if(!t)return;t.innerHTML=`
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
    `;let n=t.querySelector("#ga-search-input"),p=t.querySelector("#ga-search-projects"),f=t.querySelector("#ga-search-artists"),m=t.querySelector("#ga-search-briefs"),i=t.querySelector("#ga-search-status"),o=new URLSearchParams(location.search).get("q")||"";o&&(n.value=o);async function h(c){let l=c.trim(),u=new URL(location.href);if(l?u.searchParams.set("q",l):u.searchParams.delete("q"),history.replaceState(null,"",u.toString()),!l){p.innerHTML="",f.innerHTML="",m.innerHTML="",i.textContent="Type to search.";return}i.textContent="Searching\u2026";let S=new URL(`${a}/v1/search`);S.searchParams.set("q",l);try{let d=performance.now(),g=await fetch(S.toString());if(!g.ok)throw new Error(`HTTP ${g.status}`);let s=await g.json(),T=Math.round(performance.now()-d);p.innerHTML=s.projects.length>0?s.projects.map(v=>L(v,a)).join(""):'<p class="text-muted small">No matching projects.</p>',f.innerHTML=s.artists.length>0?s.artists.map(y).join(""):'<p class="text-muted small">No matching artists.</p>',m.innerHTML=s.briefs.length>0?s.briefs.map(w).join(""):'<p class="text-muted small">No matching briefs.</p>';let b=s.projects.length+s.artists.length+s.briefs.length;i.textContent=`${b} result${b===1?"":"s"} in ${T} ms`}catch(d){i.textContent=`Search failed: ${d.message}`}}let H=j(c=>h(c),200);n.addEventListener("input",()=>H(n.value)),t.querySelector(".ga-search-form")?.addEventListener("submit",c=>{c.preventDefault(),h(n.value)}),o?h(o):i.textContent="Type to search.",n.focus()}};window.GASearch=$;var E=$;export{E as default};
//# sourceMappingURL=ga-search.js.map
