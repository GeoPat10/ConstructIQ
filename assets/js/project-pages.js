/* Project links contain identifiers only; existing records remain unchanged. */
(function(root){
 const sections=['overview','checklist','urgent','materials','diary','issues','bc','hs','report','activity','backup'];
 const valid=id=>typeof id==='string'&&/^[-a-zA-Z0-9_]{1,150}$/.test(id);
 function parse(href){const u=new URL(href);const q=u.hash.startsWith('#project=')?new URLSearchParams(u.hash.slice(1)):u.searchParams;const id=q.get('project');if(!id)return {kind:u.pathname.endsWith('/project.html')?'missing':'home'};return {kind:valid(id)?'project':'missing',id,section:sections.includes(q.get('section'))?q.get('section'):'overview'};}
 function href(project,section,scope){const id=String(project.cloudId||project.id||'');if(!valid(id))throw new Error('Invalid project identifier');const u=new URL('project.html',scope);u.searchParams.set('project',id);u.searchParams.set('section',sections.includes(section)?section:'overview');return u.href;}
 function find(projects,id){return projects.find(p=>p.id===id||String(p.cloudId||'')===id);}
 root.CIProjectPages={parse,href,find,sections};if(typeof module!=='undefined')module.exports=root.CIProjectPages;
})(globalThis);
