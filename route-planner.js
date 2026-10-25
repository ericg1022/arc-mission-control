'use strict';
// Pure planning: simulations never change the player's saved completion or stash.
(function(root){
 const heading=text=>/^(all objectives(?: in one round)?|in one round)\s*[:.\-]?$/i.test(text.replace(/^●\s*/, '').trim());
 const traders=/\b(?:to|for)\s+(?:the\s+)?(?:Shani|Celeste|Tian Wen|Lance|Apollo|Nomadic Envoy|Cassio)\b/i;
 function create(data){
  const maps=Object.keys(data.maps).filter(m=>m!=='any'),by=Object.fromEntries(data.quests.map(q=>[q.id,q])),children=Object.fromEntries(data.quests.map(q=>[q.id,[]]));
  const questEnabled=q=>!!q&&q.raidEnabled!==false,campaign=data.quests.filter(questEnabled);
  // Routing stages defer end-game work without inventing in-game prerequisites.
  const stageAllowed=(q,s)=>questEnabled(q)&&(!(q.routingStage||0)||campaign.every(other=>(other.routingStage||0)>=(q.routingStage||0)||q.routingStageExemptions?.includes(other.id)||s.done.has(other.id)));
  const ready=(q,s)=>questEnabled(q)&&!s.done.has(q.id)&&q.prerequisites.every(id=>s.done.has(id));
  const scheduled=(q,s)=>ready(q,s)&&stageAllowed(q,s);
  const cleanStep=(r,s)=>{if(!r)return null;const quests=r.quests.filter(id=>questEnabled(by[id])&&(!s||s.done.has(id)||stageAllowed(by[id],s)));return quests.length?{...r,quests}:null;};
  for(const q of campaign)for(const p of q.prerequisites)children[p]?.push(q.id);

  // Every quest is an objective graph (the game's structure: sequences,
  // any-of choices, N-of groups, one-round groups). Each objective carries the
  // maps it can be done on; trader turn-ins happen after extraction.
  const graphs={},rules={},oneRound={};
  for(const q of data.quests){
   const scope=q.maps.includes('any')?maps:q.maps;
   const steps=q.objectives.map((t,i)=>({id:'o'+i,kind:'ATOMIC',index:i,optional:/^\s*(?:●\s*)?\(optional\)/i.test(t),children:[]})).filter(n=>!heading(q.objectives[n.index]));
   const graph=q.objectiveGraph||{root:'all',nodes:[{id:'all',kind:'ALL_OF',children:steps.map(n=>n.id)},...steps]};
   graphs[q.id]={root:graph.root,nodes:Object.fromEntries(graph.nodes.map(n=>[n.id,n]))};
   rules[q.id]=q.objectives.map((text,i)=>{const r=q.objectiveRules?.[i]||{};const turnIn=r.turnIn??(/^\s*(?:●\s*)?(?:deliver(?:y)?|bring)\b/i.test(text)&&traders.test(text));return {maps:turnIn?[...maps]:r.maps?.length?r.maps:[...scope],turnIn,optional:!!r.optional}});
   // One-round groups and the atomic objectives inside them.
   const below=id=>{const n=graphs[q.id].nodes[id];return n.kind==='ATOMIC'?[n.index]:n.children.flatMap(below)};
   oneRound[q.id]=graph.nodes.filter(n=>n.round_constraint==='IN_ONE_ROUND').map(n=>({id:n.id,indices:new Set(below(n.id))}));
  }
  const node=(q,id)=>graphs[q.id].nodes[id];
  function exclusiveChildren(q,n,checked){
   function count(id){const c=node(q,id);if(c.optional)return 0;if(c.kind==='ATOMIC')return checked.has(c.index)?1:0;return c.children.reduce((sum,id)=>sum+count(id),0)}
   const ranked=n.children.map(id=>({id,count:count(id)})).sort((a,b)=>b.count-a.count);
   return ranked[0]?.count?[ranked[0].id]:n.children;
  }
  function complete(q,id,checked){
   const n=node(q,id);if(n.optional)return true;
   if(n.kind==='ATOMIC')return checked.has(n.index)||rules[q.id][n.index].turnIn;
   const kids=n.kind==='ANY_OF_EXCLUSIVE'?exclusiveChildren(q,n,checked):n.children,results=kids.map(id=>complete(q,id,checked));
   if(n.kind==='ANY_OF'||n.kind==='ANY_OF_EXCLUSIVE')return results.some(Boolean);
   if(n.kind==='N_OF')return results.filter(Boolean).length>=n.required_count;
   return results.every(Boolean);
  }
  function frontier(q,id,checked){
   const n=node(q,id);if(complete(q,id,checked))return [];
   if(n.kind==='ATOMIC')return [n.index];
   const kids=n.kind==='SEQUENCE'?[n.children.find(id=>!complete(q,id,checked))]:n.kind==='ANY_OF_EXCLUSIVE'?exclusiveChildren(q,n,checked):n.children;
   return kids.flatMap(id=>frontier(q,id,checked));
  }
  const rootDone=(q,checked)=>complete(q,graphs[q.id].root,checked);
  const depthMemo={};function depth(id){return depthMemo[id]??(depthMemo[id]=1+Math.max(0,...children[id].map(depth)))}
  for(const q of data.quests)depth(q.id);
  const snapshot=s=>({done:new Set(s.completed.filter(id=>questEnabled(by[id]))),marks:Object.fromEntries(Object.entries(s.objectives||{}).map(([id,a])=>[id,new Set(a)]))});
  // Progress sets produced by the planner remember their cache key.
  const marksKey=set=>!set||!set.size?'':set.key??(set.key=[...set].sort((a,b)=>a-b).join(','));

  // What one raid on `map` achieves for a quest. Progress inside a one-round
  // group only counts if the whole group finishes in this raid, so partial
  // one-round work is never planned. Results depend only on the quest's own
  // marks, so they are cached: the route search reuses them heavily.
  // Equal progress sets are shared (one canonical Set per quest and key) and
  // each carries its per-map results, so repeat lookups cost one property read.
  const canonical=Object.fromEntries(data.quests.map(q=>[q.id,new Map([['',Object.assign(new Set(),{key:''})]])]));
  const canon=(q,set)=>{const k=marksKey(set),pool=canonical[q.id];let c=pool.get(k);if(!c){c=set;pool.set(k,c)}return c};
  function questWork(q,map,marks){
   const own=marks&&marks.size?(marks.rows?marks:canon(q,marks)):canonical[q.id].get(''),rows=own.rows??(own.rows={});
   const hit=rows[map];if(hit)return hit;
   const initial=own,waiting=rootDone(q,initial),blocked=new Set();
   let checked,indices;
   for(;;){
    checked=new Set(initial);indices=[];
    for(let changed=true;changed;){changed=false;
     for(const i of frontier(q,graphs[q.id].root,checked))if(!blocked.has(i)&&!rules[q.id][i].turnIn&&rules[q.id][i].maps.includes(map)&&!checked.has(i)){checked.add(i);indices.push(i);changed=true}
    }
    const broken=oneRound[q.id].filter(g=>indices.some(i=>g.indices.has(i))&&!complete(q,g.id,checked));
    if(!broken.length)break;
    for(const g of broken)for(const i of g.indices)if(!initial.has(i))blocked.add(i);
   }
   const result={indices,finishable:rootDone(q,checked),waiting,next:indices.length?canon(q,checked):initial};
   rows[map]=result;return result;
  }
  function work(q,map,s){
   if(!questEnabled(q))return {indices:[],finishable:false,waiting:false};
   const r=questWork(q,map,s.marks[q.id]);return {indices:r.indices,finishable:r.finishable,waiting:r.waiting};
  }
  const pending=(q,s)=>frontier(q,graphs[q.id].root,new Set(s.marks[q.id]||[])).map(i=>({index:i,...rules[q.id][i]}));
  const raidCosts=new Map();
  function minimumRaids(q,s){
   const initial=new Set(s.marks[q.id]||[]),key=q.id+'|'+marksKey(initial);if(raidCosts.has(key))return raidCosts.get(key);
   let layer=[initial];const seen=new Set([marksKey(initial)]);
   for(let rounds=0;rounds<=q.objectives.length;rounds++){
    const next=[];
    for(const checked of layer)for(const map of maps){const job=questWork(q,map,checked);if(job.waiting){raidCosts.set(key,rounds);return rounds}if(job.finishable){raidCosts.set(key,rounds+1);return rounds+1}if(!job.indices.length)continue;
     const k=marksKey(job.next);if(!seen.has(k)){seen.add(k);next.push(job.next)}}
    if(!next.length)break;layer=next;
   }
   // Unreachable work is not used to inflate the search's lower-bound ranking.
   raidCosts.set(key,0);return 0;
  }

  // One deployment on `map` from state `s`: every unlocked quest advances.
  // Unlocked quests per state, carried forward incrementally by simulate().
  const order=Object.fromEntries(data.quests.map((q,i)=>[q.id,i])),staged=campaign.filter(q=>q.routingStage);
  const openQuests=s=>s.open??(s.open=data.quests.filter(q=>scheduled(q,s)));
  function step(s,map,unlocked=openQuests(s),lite=false){
   const jobs=[];
   for(const q of unlocked){const r=questWork(q,map,s.marks[q.id]);if(r.indices.length||(r.waiting&&(q.maps.includes('any')||q.maps.includes(map))))jobs.push({q,...r})}
   if(!jobs.length)return null;
   if(lite)return {map,quests:jobs.map(j=>j.q.id),working:jobs.filter(j=>j.indices.length).length};
   const done=new Set(s.done);for(const j of jobs)if(j.finishable)done.add(j.q.id);
   const unlocks=campaign.filter(q=>!done.has(q.id)&&!scheduled(q,s)&&scheduled(q,{...s,done})).length;
   const finishes=jobs.filter(j=>j.finishable),objectives=jobs.reduce((n,j)=>n+j.indices.length,0);
   const specific=jobs.filter(j=>j.indices.some(i=>rules[j.q.id][i].maps.length<maps.length)).length;
   const gain=finishes.length*100+unlocks*40+finishes.reduce((n,j)=>n+depth(j.q.id)*3,0)+objectives*2+specific*2;
   return {map,quests:jobs.map(j=>j.q.id),finishable:finishes.map(j=>j.q.id),objectives,unlocks,gain,working:jobs.filter(j=>j.indices.length).length};
  }
  function candidates(s){const unlocked=openQuests(s);return maps.map(map=>step(s,map,unlocked)).filter(Boolean)}
  function simulate(s,r){
   const open=openQuests(s),next={done:new Set(s.done),marks:{...s.marks}},finished=[];
   for(const id of r.quests){const q=by[id];if(!open.includes(q))continue;const job=questWork(q,r.map,s.marks[id]);if(!job.indices.length&&!job.waiting)continue;
    if(job.indices.length)next.marks[id]=job.next;
    if(job.finishable){next.done.add(id);finished.push(id);delete next.marks[id]}
   }
   if(finished.length){
    next.open=open.filter(q=>!next.done.has(q.id));
    for(const q of [...finished.flatMap(id=>children[id].map(c=>by[c])),...staged])if(!next.open.includes(q)&&scheduled(q,next))next.open.push(q);
    next.open.sort((a,b)=>order[a.id]-order[b.id]);
   }else next.open=open;
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
  const stateKey=s=>{let k='';for(const q of campaign)k+=s.done.has(q.id)?'x;':marksKey(s.marks[q.id])+';';return k};
  // Lower bound on remaining raids: the longest unlock chain, costing each
  // quest the fewest raids its own objectives need.
  function bound(s){const memo={};function chain(id){if(!questEnabled(by[id])||s.done.has(id))return 0;return memo[id]??(memo[id]=minimumRaids(by[id],s)+Math.max(0,...children[id].map(chain)))}return Math.max(0,...campaign.map(q=>chain(q.id)))}
  function forecast(saved,current,limit=250,width=32){
   current=cleanStep(current,snapshot(saved));
   const initial=snapshot(saved),previous=saved.lastMap||'dam-battlegrounds';
   let start={s:initial,path:[],previous,changes:0,singles:0};
   if(current){start={s:simulate(initial,current).state,path:[current],previous:current.map,changes:0,singles:0}}
   let layer=[start],winner=start;
   // Bounded whole-route search compares alternative map orders, rather than
   // committing to the map with the largest immediate bundle. It is a planning
   // heuristic, not a claim that a global mathematical minimum is proven.
   for(let round=start.path.length;round<limit&&layer.length;round++){
    const unique=new Map(),goals=[];
    for(const n of layer){if(n.s.done.size===campaign.length){goals.push(n);continue}
     for(const r of candidates(n.s)){
      const next={s:simulate(n.s,r).state,path:[...n.path,r],previous:r.map,changes:n.changes+(n.previous!==r.map?1:0),singles:n.singles+(r.working===1?1:0)};
      if(next.s.done.size===campaign.length){goals.push(next);continue}
      const signature=stateKey(next.s)+'|'+next.previous,old=unique.get(signature);if(!old||next.changes<old.changes||(next.changes===old.changes&&next.singles<old.singles))unique.set(signature,next);
     }
    }
    if(goals.length){winner=goals.sort((a,b)=>a.path.length-b.path.length||a.changes-b.changes||a.singles-b.singles)[0];layer=[];break}
    layer=[...unique.values()].map(n=>({...n,bound:bound(n.s),progress:Object.entries(n.s.marks).reduce((sum,[id,a])=>sum+(n.s.done.has(id)?0:a.size),0)})).sort((a,b)=>a.bound-b.bound||b.s.done.size-a.s.done.size||b.progress-a.progress||a.changes-b.changes||a.singles-b.singles).slice(0,width);
    if(layer.length)winner=layer[0];
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
    const r=step(s,map);if(!r)continue;
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
  // Local search over whole map orders. A route is just its list of maps:
  // replaying it rebuilds each raid's bundle from real progress, so a move
  // that drops, swaps, replaces or relocates a raid is always valid to test.
  // Unfinished routes are completed greedily. Late-acceptance hill climbing
  // lets the search cross plateaus of equally good routes.
  function optimize(saved,current,{start=[],timeLimit=5000,maxEvaluations=Infinity,seed=1,memory=50,onImprove}={}){
   current=cleanStep(current,snapshot(saved));
   const base=snapshot(saved),origin=current?simulate(base,current).state:base,startPrevious=current?.map??saved.lastMap;
   let rnd=seed>>>0||1;const random=()=>(rnd=(rnd*1664525+1013904223)>>>0)/4294967296,pick=n=>Math.floor(random()*n);
   // Routes are replayed thousands of times, so run() mutates one compact
   // state (flags per campaign quest) instead of copying planner states.
   const N=campaign.length,qi=Object.fromEntries(campaign.map((q,i)=>[q.id,i]));
   const kids=campaign.map(q=>children[q.id].map(id=>qi[id]).filter(i=>i!==undefined)),needs=campaign.map(q=>q.prerequisites.map(id=>qi[id]??-1));
   const stagedIdx=campaign.map((q,i)=>q.routingStage?i:-1).filter(i=>i>=0);
   const unlockedNow=(i,done)=>!done[i]&&needs[i].every(j=>j>=0&&done[j])&&(!campaign[i].routingStage||campaign.every((o,j)=>(o.routingStage||0)>=campaign[i].routingStage||campaign[i].routingStageExemptions?.includes(o.id)||done[j]));
   const done0=new Uint8Array(N),marks0=campaign.map(q=>origin.marks[q.id]?canon(q,origin.marks[q.id]):undefined);
   for(const [i,q] of campaign.entries())if(origin.done.has(q.id))done0[i]=1;
   const open0=campaign.map((_,i)=>i).filter(i=>unlockedNow(i,done0)),count0=done0.reduce((n,v)=>n+v,0);
   function run(seq){
    const done=done0.slice(),marks=marks0.slice(),out=[];let open=open0.slice(),count=count0,previous=startPrevious,raids=0,changes=0,singles=0;
    const jobs=map=>{const list=[];let working=0,finishing=0;for(const i of open){const q=campaign[i],r=questWork(q,map,marks[i]);if(r.indices.length)working++;else if(!(r.waiting&&(q.maps.includes('any')||q.maps.includes(map))))continue;if(r.finishable)finishing++;list.push(i,r)}return {list,working,finishing}};
    const apply=(map,{list,working})=>{
     let finished=false;
     for(let k=0;k<list.length;k+=2){const i=list[k],r=list[k+1];if(r.indices.length)marks[i]=r.next;if(r.finishable){done[i]=1;count++;finished=true}}
     if(finished){open=open.filter(i=>!done[i]);for(let k=0;k<list.length;k+=2){const i=list[k];if(done[i])for(const c of kids[i])if(!open.includes(c)&&unlockedNow(c,done))open.push(c)}for(const c of stagedIdx)if(!open.includes(c)&&unlockedNow(c,done))open.push(c)}
     out.push(map);raids++;if(previous&&previous!==map)changes++;if(working===1)singles++;previous=map;
    };
    for(const map of seq){if(count===N)break;const j=jobs(map);if(j.working)apply(map,j)}
    while(count<N&&out.length<250){let best=null,value=-Infinity;for(const map of maps){const j=jobs(map);if(!j.working)continue;const v=j.finishing*100+j.working*2-(map!==previous?1:0);if(v>value){value=v;best=[map,j]}}if(!best)break;apply(...best)}
    return {seq:out,score:count<N?Infinity:raids*1e6+changes*1e3+singles};
   }
   const t0=Date.now();let evaluations=0;
   let cur=run(start.map(r=>typeof r==='string'?r:r.map)),best=cur;
   const history=new Array(memory).fill(cur.score);
   while(evaluations<maxEvaluations&&Date.now()-t0<timeLimit){
    const seq=[...cur.seq],n=seq.length;if(!n)break;
    const move=pick(5),i=pick(n);
    if(move===0)seq.splice(i,1);
    else if(move===1)seq[i]=maps[pick(maps.length)];
    else if(move===2){const j=Math.min(n-1,i+1);[seq[i],seq[j]]=[seq[j],seq[i]]}
    else if(move===3){const [m]=seq.splice(i,1);seq.splice(pick(n),0,m)}
    else {const len=1+pick(Math.min(4,n-i)),j=pick(n-len+1),seg=seq.splice(i,len);seq.splice(j,0,...seg)}
    const next=run(seq);evaluations++;
    const slot=evaluations%history.length;
    if(next.score<=cur.score||next.score<=history[slot]){cur=next;if(cur.score<best.score){best=cur;onImprove?.(finalize(best.seq))}}
    history[slot]=cur.score;
   }
   function finalize(seq){let s=origin;const steps=current?[current]:[];for(const map of seq){const r=step(s,map);if(!r?.working)continue;steps.push(r);s=simulate(s,r).state}return describe(saved,current,steps)}
   const result=finalize(best.seq);result.evaluations=evaluations;return result;
  }
  // Time-boxed route search: many short optimizations from scratch find
  // different good regions, then the best route found is refined.
  function search(saved,current,{prior=[],timeLimit=15000,shortRuns=15,shortEvaluations=3000,seed=1,onImprove}={}){
   const t0=Date.now(),left=()=>timeLimit-(Date.now()-t0);let best=null;
   const offer=r=>{const b=better(best,r);if(b&&b!==best){best=b;onImprove?.(best)}};
   const start=r=>r?(current?r.steps.slice(1):r.steps):[];
   if(prior?.length)offer(replay(saved,current,prior));
   for(let k=0;k<shortRuns&&left()>0;k++)offer(optimize(saved,current,{start:k===0?start(best):[],maxEvaluations:shortEvaluations,timeLimit:Math.min(left(),timeLimit*.6/shortRuns),seed:seed*977+k}));
   if(left()>0)offer(optimize(saved,current,{start:start(best),timeLimit:left(),seed}));
   return best;
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
   const q=by[id],checked=new Set(s.marks[id]||[]);
   if(!Object.values(graphs[id].nodes).some(n=>['ANY_OF','ANY_OF_EXCLUSIVE','N_OF'].includes(n.kind)))return '';
   function visit(key,choice=''){
    const n=node(q,key);if(['ANY_OF','ANY_OF_EXCLUSIVE','N_OF'].includes(n.kind))choice=complete(q,key,checked)?'satisfied':'alternative';
    if(n.kind==='ATOMIC')return n.index===index?choice:null;
    for(const child of n.children){const status=n.kind==='ANY_OF_EXCLUSIVE'&&!complete(q,key,checked)&&!exclusiveChildren(q,n,checked).includes(child)?'unselected':choice;const result=visit(child,status);if(result!==null)return result}return null;
   }
   return visit(graphs[id].root)||'';
  }
  const objectiveMaps=(id,i)=>rules[id][i].maps;
  const turnInObjective=(id,i)=>rules[id][i].turnIn;
  const oneRoundObjective=(id,i)=>oneRound[id].some(g=>g.indices.has(i));
  const remainingMaps=(id,s)=>maps.filter(map=>work(by[id],map,s).indices.length);
  const multiMap=id=>!maps.some(map=>questWork(by[id],map,null).finishable);
  return {maps,heading,choiceStatus,objectiveMaps,turnInObjective,oneRoundObjective,remainingMaps,multiMap,snapshot,ready,stageAllowed,scheduled,minimumRaids,pending,work,candidates,simulate,choose,forecast,replay,better,quickForecast,optimize,search,describe,allocations,bound};
 }
 const api={create,heading};root.ARCPlanner=api;if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(globalThis);
