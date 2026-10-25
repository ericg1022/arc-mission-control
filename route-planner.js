'use strict';
// Pure planning: simulations never change the player's saved completion or stash.
(function(root){
 const heading=text=>/^(all objectives(?: in one round)?|in one round)\s*[:.\-]?$/i.test(text.replace(/^●\s*/, '').trim());
 function create(data){
  const maps=Object.keys(data.maps).filter(m=>m!=='any'),by=Object.fromEntries(data.quests.map(q=>[q.id,q])),children=Object.fromEntries(data.quests.map(q=>[q.id,[]]));
  const questEnabled=q=>!!q&&q.raidEnabled!==false,campaign=data.quests.filter(questEnabled);
  // Routing stages defer end-game work without inventing in-game prerequisites.
  const stageAllowed=(q,s)=>questEnabled(q)&&(!(q.routingStage||0)||campaign.every(other=>(other.routingStage||0)>=(q.routingStage||0)||q.routingStageExemptions?.includes(other.id)||s.done.has(other.id)));
  const scheduled=(q,s)=>ready(q,s)&&stageAllowed(q,s);
  const cleanStep=(r,s)=>{if(!r)return null;const quests=r.quests.filter(id=>questEnabled(by[id])&&(!s||s.done.has(id)||stageAllowed(by[id],s)));return quests.length?{...r,quests}:null;};
  for(const q of campaign)for(const p of q.prerequisites)children[p].push(q.id);
  const aliases={'dam-battlegrounds':/\b(?:dam battlegrounds|the dam)\b/i,'buried-city':/\bburied city\b/i,spaceport:/\bspaceport\b/i,'the-blue-gate':/\b(?:the )?blue gate\b/i,'stella-montis':/\bstella montis\b/i,'riven-tides':/\briven tides\b/i,'pendola-pass':/\bpendola pass\b/i};
  const defs={};
  for(const q of data.quests){
   let scope=q.maps.includes('any')?maps:q.maps;
   const parts=q.objectives.map((text,i)=>{
    // Trader deliveries happen after extraction. They must not inherit the
    // preceding location and create a spurious return trip to that map.
    const turnIn=/^\s*(?:●\s*)?(?:deliver(?:y)?|bring)\b.*\b(?:to|for)\s+(?:the\s+)?(?:Shani|Celeste|Tian Wen|Lance|Apollo|Nomadic Envoy|Cassio)\b/i.test(text);
    const explicit=maps.filter(m=>aliases[m]?.test(text));
    if(explicit.length&&!turnIn)scope=explicit;
    return {index:i,maps:turnIn?[...maps]:[...(q.objectiveRules?.[i]?.maps||scope)],optional:!!q.objectiveRules?.[i]?.optional||/^\s*(?:●\s*)?\(optional\)/i.test(text),heading:heading(text),turnIn,requires:[]};
   });
   // The notice-board stage uses a confirmed ENELICA building before Buried City.
   if(q.id==='paving-the-way'){for(const i of [0,1])parts[i].maps=['dam-battlegrounds','the-blue-gate'];for(const i of [2,3])parts[i].requires=[0,1]}
   // Keep the listed story stages together while allowing checked later stages
   // in an existing save to remain checked.
   if(q.id==='a-rising-tide')for(const i of [2,3,4])parts[i].requires=[0,1];
   if(q.id==='the-clean-dream')for(const i of [2,3,4])parts[i].requires=[0,1];
   defs[q.id]=parts;
  }
  const graphs={};
  for(const q of data.quests)if(q.objectiveGraph)graphs[q.id]=Object.fromEntries(q.objectiveGraph.nodes.map(n=>[n.id,n]));
  function exclusiveChildren(q,n,checked){
   function count(id){const node=graphs[q.id][id];if(node.optional)return 0;if(node.kind==='ATOMIC')return checked.has(node.index)?1:0;return node.children.reduce((sum,id)=>sum+count(id),0)}
   const ranked=n.children.map(id=>({id,count:count(id)})).sort((a,b)=>b.count-a.count);
   return ranked[0]?.count?[ranked[0].id]:n.children;
  }
  function complete(q,id,checked){
   const n=graphs[q.id][id];if(n.optional)return true;
   if(n.kind==='ATOMIC')return checked.has(n.index)||defs[q.id][n.index].turnIn;
   const children=n.kind==='ANY_OF_EXCLUSIVE'?exclusiveChildren(q,n,checked):n.children,results=children.map(id=>complete(q,id,checked));
   if(n.kind==='ANY_OF'||n.kind==='ANY_OF_EXCLUSIVE')return results.some(Boolean);
   if(n.kind==='N_OF')return results.filter(Boolean).length>=n.required_count;
   return results.every(Boolean);
  }
  function frontier(q,id,checked){
   const n=graphs[q.id][id];if(complete(q,id,checked))return [];
   if(n.kind==='ATOMIC')return [n.index];
   const children=n.kind==='SEQUENCE'?[n.children.find(id=>!complete(q,id,checked))]:n.kind==='ANY_OF_EXCLUSIVE'?exclusiveChildren(q,n,checked):n.children;
   return children.flatMap(id=>frontier(q,id,checked));
  }
  const depthMemo={};function depth(id){return depthMemo[id]??(depthMemo[id]=1+Math.max(0,...children[id].map(depth)))}
  for(const q of data.quests)depth(q.id);
  const snapshot=s=>({done:new Set(s.completed.filter(id=>questEnabled(by[id]))),marks:Object.fromEntries(Object.entries(s.objectives||{}).map(([id,a])=>[id,new Set(a)]))});
  const ready=(q,s)=>questEnabled(q)&&!s.done.has(q.id)&&q.prerequisites.every(id=>s.done.has(id));
  const pending=(q,s)=>graphs[q.id]?frontier(q,q.objectiveGraph.root,new Set(s.marks[q.id]||[])).map(i=>defs[q.id][i]):defs[q.id].filter(p=>!p.heading&&!p.optional&&!s.marks[q.id]?.has(p.index));
  function work(q,map,s){
   if(!questEnabled(q))return {indices:[],finishable:false,waiting:false};
   if(graphs[q.id]){
    const checked=new Set(s.marks[q.id]||[]),indices=[],waiting=complete(q,q.objectiveGraph.root,checked);
    for(let round=0;round<q.objectives.length;round++){
     const next=frontier(q,q.objectiveGraph.root,checked).filter(i=>defs[q.id][i].maps.includes(map));
     if(!next.length)break;for(const i of next){if(!frontier(q,q.objectiveGraph.root,checked).includes(i))continue;checked.add(i);indices.push(i)}
    }
    return {indices,finishable:complete(q,q.objectiveGraph.root,checked),waiting};
   }
   const left=pending(q,s),checked=new Set(s.marks[q.id]||[]),indices=[];let changed=true;
   while(changed){changed=false;for(const p of left)if(!p.turnIn&&!checked.has(p.index)&&p.maps.includes(map)&&p.requires.every(i=>checked.has(i))){checked.add(p.index);indices.push(p.index);changed=true}}
   return {indices,finishable:left.every(p=>p.turnIn||checked.has(p.index)),waiting:left.every(p=>p.turnIn)};
  }
  const raidCosts=new Map();
  function minimumRaids(q,s){
   const initial=new Set(s.marks[q.id]||[]),key=q.id+'|'+[...initial].sort((a,b)=>a-b).join(',');if(raidCosts.has(key))return raidCosts.get(key);
   let frontier=[initial],seen=new Set();
   for(let rounds=0;rounds<=q.objectives.length;rounds++){
    const next=[];
    for(const checked of frontier){const state={done:s.done,marks:{[q.id]:checked}};
     for(const map of maps){const job=work(q,map,state);if(job.waiting){raidCosts.set(key,rounds);return rounds}if(job.finishable){raidCosts.set(key,rounds+1);return rounds+1}if(!job.indices.length)continue;
      const marks=new Set([...checked,...job.indices]),signature=[...marks].sort((a,b)=>a-b).join(',');if(!seen.has(signature)){seen.add(signature);next.push(marks)}
     }
    }
    if(!next.length)break;frontier=next;
   }
   // Unreachable work is not used to inflate the search's lower-bound ranking.
   raidCosts.set(key,0);return 0;
  }
  function candidates(s){
   const unlocked=data.quests.filter(q=>scheduled(q,s));
   return maps.map(map=>{
    const jobs=unlocked.map(q=>({q,...work(q,map,s)})).filter(j=>j.indices.length||(j.waiting&&(j.q.maps.includes('any')||j.q.maps.includes(map))));
    if(!jobs.length)return null;
    const done=new Set(s.done);for(const j of jobs)if(j.finishable)done.add(j.q.id);
    const unlocks=campaign.filter(q=>!done.has(q.id)&&!scheduled(q,s)&&scheduled(q,{...s,done})).length;
    const finishes=jobs.filter(j=>j.finishable),objectives=jobs.reduce((n,j)=>n+j.indices.length,0);
    const specific=jobs.filter(j=>j.indices.some(i=>defs[j.q.id][i].maps.length<maps.length)).length;
    const gain=finishes.length*100+unlocks*40+finishes.reduce((n,j)=>n+depth(j.q.id)*3,0)+objectives*2+specific*2;
    return {map,quests:jobs.map(j=>j.q.id),finishable:finishes.map(j=>j.q.id),objectives,unlocks,gain};
   }).filter(Boolean);
  }
  function simulate(s,r){
   const next={done:new Set(s.done),marks:{...s.marks}},finished=[];
   for(const id of r.quests){const q=by[id];if(!scheduled(q,s))continue;const job=work(q,r.map,s);if(!job.indices.length&&!job.waiting)continue;
    next.marks[id]=new Set(s.marks[id]||[]);for(const i of job.indices)next.marks[id].add(i);
    if(job.finishable){next.done.add(id);finished.push(id)}
   }
   return {state:next,finished};
  }
  function choose(s,previous,levels=3){
   const options=candidates(s).sort((a,b)=>b.gain-a.gain||Number(b.map===previous)-Number(a.map===previous)||maps.indexOf(a.map)-maps.indexOf(b.map));
   let best=null;
   for(const r of options.slice(0,3)){
    let value=r.gain-(previous&&r.map!==previous?1:0);
    if(levels>1){const after=simulate(s,r).state,following=choose(after,r.map,levels-1);if(following)value+=following.value*.55}
    const candidate={...r,value};if(!best||value>best.value+1e-8)best=candidate;
   }
   return best;
  }
  function forecast(saved,current,limit=250,width=32){
   current=cleanStep(current,snapshot(saved));
   const initial=snapshot(saved),previous=saved.lastMap||'dam-battlegrounds',first=current?.number??(saved.deploymentCount??saved.raids?.length??0)+1;

   function bound(s){const memo={};function chain(id){if(!questEnabled(by[id])||s.done.has(id))return 0;return memo[id]??(memo[id]=minimumRaids(by[id],s)+Math.max(0,...children[id].map(chain)))}return Math.max(0,...data.quests.map(q=>chain(q.id)))}
   const key=s=>data.quests.map(q=>s.done.has(q.id)?'x':[...(s.marks[q.id]||[])].sort((a,b)=>a-b).join(',')).join(';');
   let start={s:initial,path:[],previous,changes:0,singles:0};
   if(current){start={s:simulate(initial,current).state,path:[current],previous:current.map,changes:0,singles:0}}
   let frontier=[start],winner=start;
   // Bounded whole-route search compares alternative map orders, rather than
   // committing to the map with the largest immediate bundle. It is a planning
   // heuristic, not a claim that a global mathematical minimum is proven.
   for(let round=start.path.length;round<limit&&frontier.length;round++){
    const unique=new Map(),goals=[];
    for(const node of frontier){if(node.s.done.size===campaign.length){goals.push(node);continue}
     for(const r of candidates(node.s)){
      const next={s:simulate(node.s,r).state,path:[...node.path,r],previous:r.map,changes:node.changes+(node.previous!==r.map?1:0),singles:node.singles+(r.quests.filter(id=>work(by[id],r.map,node.s).indices.length).length===1?1:0)};
      if(next.s.done.size===campaign.length){goals.push(next);continue}
      const signature=key(next.s)+'|'+next.previous,old=unique.get(signature);if(!old||next.changes<old.changes||(next.changes===old.changes&&next.singles<old.singles))unique.set(signature,next);
     }
    }
    if(goals.length){winner=goals.sort((a,b)=>a.path.length-b.path.length||a.changes-b.changes||a.singles-b.singles)[0];frontier=[];break}
    frontier=[...unique.values()].map(n=>({...n,bound:bound(n.s),progress:Object.entries(n.s.marks).reduce((sum,[id,a])=>sum+(n.s.done.has(id)?0:a.size),0)})).sort((a,b)=>a.bound-b.bound||b.s.done.size-a.s.done.size||b.progress-a.progress||a.changes-b.changes||a.singles-b.singles).slice(0,width);
    if(frontier.length)winner=frontier[0];
   }
   return describe(saved,current,winner.path);
  }
  function describe(saved,current,path){
   current=cleanStep(current,snapshot(saved));
   let s=snapshot(saved);const starts={},finishes={},first=current?.number??(saved.deploymentCount??saved.raids?.length??0)+1;
   let raids=0,changes=0,singles=0,previous=saved.lastMap;
   const steps=[];for(const raw of path){
    const r=cleanStep(raw,s);if(!r)continue;
    const step={...r,number:first+steps.length,mapName:data.maps[r.map].name};
    const jobs=step.quests.filter(id=>scheduled(by[id],s)&&work(by[id],step.map,s).indices.length);
    if(jobs.length){raids++;if(previous&&previous!==step.map)changes++;previous=step.map;if(jobs.length===1)singles++;}
    for(const id of step.quests)if(scheduled(by[id],s)&&starts[id]===undefined)starts[id]=step.number;
    const after=simulate(s,step);for(const id of after.finished)finishes[id]=step.number;s=after.state;steps.push(step);
   }
   return {steps,starts,finishes,remaining:s.done.size<campaign.length,score:[raids,changes,singles]};
  }
  // Replay map orders against REAL progress, reconstructing every unlocked
  // bundle rather than trusting cached quest lists or projected completions.
  function replay(saved,current,path){
   current=cleanStep(current,snapshot(saved));
   if(!Array.isArray(path)||path.length>250)return null;
   let s=snapshot(saved),steps=[];
   if(current){steps.push(current);s=simulate(s,current).state;}
   for(const [i,old] of path.entries()){
    if(i===0&&current&&old?.number===current.number&&old?.map===current.map)continue;
    if(Number.isSafeInteger(old?.number)&&old.number<=(saved.deploymentCount??0)&&old.quests?.every(id=>by[id]&&(s.done.has(id)||!work(by[id],old.map,s).indices.length)))continue;
    const map=typeof old==='string'?old:old?.map;if(!maps.includes(map))return null;
    const r=candidates(s).find(r=>r.map===map);if(!r)continue;
    steps.push(r);s=simulate(s,r).state;
   }
   const result=describe(saved,current,steps);return result.remaining?null:result;
  }
  function better(a,b){
   if(!a)return b;if(!b)return a;if(a.remaining&&!b.remaining)return b;if(b.remaining&&!a.remaining)return a;
   for(let i=0;i<3;i++){if(a.score[i]<b.score[i])return a;if(a.score[i]>b.score[i])return b;}
   return a;
  }
  function quickForecast(saved,current){
   current=cleanStep(current,snapshot(saved));
   let s=snapshot(saved),steps=[],previous=saved.lastMap;
   if(current){steps.push(current);s=simulate(s,current).state;previous=current.map;}
   for(let i=steps.length;i<250&&s.done.size<campaign.length;i++){
    const r=choose(s,previous,2);if(!r)break;steps.push(r);s=simulate(s,r).state;previous=r.map;
   }
   return describe(saved,current,steps);
  }

  function allocations(saved,forecast){
   const done=new Set(saved.completed),order=Object.fromEntries(saved.completed.map((id,i)=>[id,i])),result={};
   for(const m of data.materials){
    const excluded=saved.rewardOptOut?.includes(m.name),used={};
    result[m.name]=(m.rewardSources||[]).filter(source=>questEnabled(by[source.id])).map(source=>{
     let pool=excluded?0:source.qty;
     const eligible=source.uses.filter(u=>u.possible&&questEnabled(by[u.id])).sort((a,b)=>(done.has(a.id)?order[a.id]:forecast.starts[a.id]??Infinity)-(done.has(b.id)?order[b.id]:forecast.starts[b.id]??Infinity));
     const credits={};
     for(const u of eligible){
      const before=done.has(source.id)?(!done.has(u.id)||order[source.id]<order[u.id]):(!done.has(u.id)&&forecast.finishes[source.id]!==undefined&&forecast.starts[u.id]!==undefined&&forecast.finishes[source.id]<forecast.starts[u.id]);
      const credit=before?Math.min(pool,Math.max(0,u.qty-(used[u.id]||0))):0;credits[u.id]=credit;pool-=credit;used[u.id]=(used[u.id]||0)+credit;
     }
     const uses=source.uses.filter(u=>questEnabled(by[u.id])).map(u=>({...u,credit:credits[u.id]||0}));return {...source,uses,credit:uses.reduce((n,u)=>n+u.credit,0)};
    });
   }
   return result;
  }
  function choiceStatus(id,index,s){
   const q=by[id],nodes=graphs[id];if(!nodes)return '';
   const checked=new Set(s.marks[id]||[]);
   function visit(node,choice=''){
    const n=nodes[node];if(['ANY_OF','ANY_OF_EXCLUSIVE','N_OF'].includes(n.kind))choice=complete(q,node,checked)?'satisfied':'alternative';
    if(n.kind==='ATOMIC')return n.index===index?choice:null;
    for(const child of n.children){const status=n.kind==='ANY_OF_EXCLUSIVE'&&!complete(q,node,checked)&&!exclusiveChildren(q,n,checked).includes(child)?'unselected':choice;const result=visit(child,status);if(result!==null)return result}return null;
   }
   return visit(q.objectiveGraph.root)||'';
  }
  const objectiveMaps=(id,i)=>defs[id][i].maps;
  const turnInObjective=(id,i)=>defs[id][i].turnIn;
  const remainingMaps=(id,s)=>maps.filter(map=>work(by[id],map,s).indices.length);
  const multiMap=id=>{if(graphs[id])return !maps.some(map=>work(by[id],map,{marks:{}}).finishable);let intersection=maps;for(const p of defs[id])if(!p.heading)intersection=intersection.filter(m=>p.maps.includes(m));return !intersection.length};
  return {maps,heading,choiceStatus,objectiveMaps,turnInObjective,remainingMaps,multiMap,snapshot,ready,stageAllowed,scheduled,minimumRaids,pending,work,candidates,simulate,choose,forecast,replay,better,quickForecast,describe,allocations};
 }
 const api={create,heading};root.ARCPlanner=api;if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(globalThis);
