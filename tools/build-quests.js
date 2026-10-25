#!/usr/bin/env node
'use strict';
// Rebuilds the quest layer of offline-resources.js from the snapshots written
// by fetch-sources.js, keeping the hand-curated layers (map assignments,
// raid prep, choice groups, notes, objective map markers) attached to the
// right objectives. Also regenerates the route worker from route-planner.js.
//
//   node tools/build-quests.js           # rebuild + write tools/quest-data-report.md
//   node tools/build-quests.js --check   # exit 1 if a rebuild would change anything
//
// Source precedence
// - Objectives, objective structure (sequence / any-of / one-round) and
//   prerequisites come from MetaForge's quest manifests, which carry the game's
//   objective graph. Where the wiki agrees with the existing wording better than
//   MetaForge does, the existing wording is kept.
// - Quest maps, traders, required items, rewards and everything curated stay as
//   they are; disagreements between the sources are listed in the report.
const fs=require('fs'),path=require('path'),vm=require('vm');
const ROOT=path.join(__dirname,'..'),SRC=path.join(__dirname,'sources');
const read=f=>fs.readFileSync(path.join(ROOT,f),'utf8');
const load=(file,name)=>{const ctx={globalThis:{}};ctx.globalThis=ctx;vm.runInNewContext(read(file),ctx);return ctx[name]};
const offline=load('offline-resources.js','ARCOffline'),objectiveMaps=load('objective-maps.js','ARCObjectiveMaps');
const source=f=>JSON.parse(fs.readFileSync(path.join(SRC,f),'utf8'));
const hub=source('hub.json'),mf=source('metaforge.json'),wiki=source('wiki.json');
const index=s=>Object.fromEntries(s.quests.map(q=>[q.id,q]));
const H=index(hub),M=index(mf),W=index(wiki);
const data=offline.data,before=JSON.stringify([data.quests,objectiveMaps]);

const bullet=s=>'● '+s;
const strip=s=>s.replace(/^\s*●\s*/,'');
const loose=s=>strip(s).toLowerCase().replace(/\((?:in one round|optional)\)|^in one round:|^all objectives in one round:?/g,'').replace(/[^a-z0-9]/g,'');
function similarity(a,b){a=loose(a);b=loose(b);if(a===b)return 1;if(a.length<2||b.length<2)return 0;const grams=s=>{const m=new Map();for(let i=0;i<s.length-1;i++){const g=s.slice(i,i+2);m.set(g,(m.get(g)||0)+1)}return m};const A=grams(a),B=grams(b);let n=0;for(const [g,c] of A)n+=Math.min(c,B.get(g)||0);return 2*n/(a.length+b.length-2)}
const sameItems=(a,b)=>JSON.stringify(a.map(i=>`${i.qty}x ${loose(i.name)}`).sort())===JSON.stringify(b.map(i=>`${i.qty}x ${loose(i.name)}`).sort());
const heading=t=>/^(all objectives(?: in one round)?|in one round)\s*[:.\-]?$/i.test(strip(t).trim());
const allMaps=Object.keys(data.maps).filter(m=>m!=='any');
const aliases={'dam-battlegrounds':/\b(?:dam battlegrounds|the dam)\b/i,'buried-city':/\bburied city\b/i,spaceport:/\bspaceport\b/i,'the-blue-gate':/\b(?:the )?blue gate\b/i,'stella-montis':/\bstella montis\b/i,'riven-tides':/\briven tides\b/i,'pendola-pass':/\bpendola pass\b/i};
const traders=/\b(?:to|for)\s+(?:the\s+)?(?:Shani|Celeste|Tian Wen|Lance|Apollo|Nomadic Envoy|Cassio)\b/i;
const turnIn=(text,node)=>(node?.action?.type==='Deliver'||/^\s*(?:●\s*)?(?:deliver(?:y)?|bring|get)\b/i.test(text))&&traders.test(text);
// Map assignments for objectives that have no per-objective rule yet: the
// derivation the planner used before every quest carried one. A map named in
// the text applies to it and later steps; turn-ins can happen anywhere.
function legacyMaps(q){
 let scope=q.maps.includes('any')?allMaps:q.maps;
 const out=q.objectives.map((text,i)=>{
  const isTurnIn=/^\s*(?:●\s*)?(?:deliver(?:y)?|bring)\b.*\b(?:to|for)\s+(?:the\s+)?(?:Shani|Celeste|Tian Wen|Lance|Apollo|Nomadic Envoy|Cassio)\b/i.test(text);
  const named=allMaps.filter(m=>aliases[m].test(text));if(named.length&&!isTurnIn)scope=named;
  return {maps:isTurnIn?[...allMaps]:[...(q.objectiveRules?.[i]?.maps||scope)],turnIn:isTurnIn};
 });
 if(q.id==='paving-the-way')for(const i of [0,1])out[i].maps=['dam-battlegrounds','the-blue-gate'];
 return out;
}

// Pair old objectives with new ones by wording, preferring nearby positions so
// repeated steps (four identical "Install ARC ..." groups) keep their order.
function pair(oldList,newList,min=.55){
 const pairs=[];
 oldList.forEach((o,i)=>newList.forEach((n,j)=>{const s=similarity(o,n);if(s>=min)pairs.push({i,j,s:s-.02*Math.abs(i/Math.max(1,oldList.length)-j/Math.max(1,newList.length))})}));
 pairs.sort((a,b)=>b.s-a.s);const map=new Map(),used=new Set();
 for(const p of pairs)if(!map.has(p.i)&&!used.has(p.j)){map.set(p.i,p.j);used.add(p.j)}
 return map;
}
// Depth-first atomic order: the order objectives appear in-game.
function atomics(graph){const nodes=Object.fromEntries(graph.nodes.map(n=>[n.id,n])),out=[];const visit=id=>{const n=nodes[id];if(n.kind==='ATOMIC')out.push(n);else n.children.forEach(visit)};visit(graph.root);return out}

const report={objectives:[],conflicts:[],prerequisites:[],traders:[],maps:[],required:[],rewards:[],missing:[]},migration={};
for(const q of data.quests){
 const m=M[q.id],h=H[q.id],w=W[q.id];
 for(const [name,s] of [['MetaForge',m],['Arc Raiders Hub',h],['wiki',w]])if(!s)report.missing.push(`${q.name}: not on ${name}`);
 if(!m)continue;
 // ---- objectives and structure
 const legacy=legacyMaps(q);
 const oldTexts=q.objectives,oldIdx=oldTexts.map((t,i)=>i).filter(i=>!heading(oldTexts[i]));
 const graph=JSON.parse(JSON.stringify(m.objectiveGraph)),nodes=atomics(graph);
 // Curated: an ANY_OF the game treats as "finish the option you started".
 for(const n of graph.nodes)if(n.kind==='ANY_OF'&&q.objectiveGraph?.nodes.find(o=>o.id===n.id)?.kind==='ANY_OF_EXCLUSIVE')n.kind='ANY_OF_EXCLUSIVE';
 // A curated graph with the same steps keeps its numbering, so nothing moves.
 const same=q.objectiveGraph&&q.objectiveGraph.nodes.filter(n=>n.kind==='ATOMIC').length===nodes.length&&nodes.every(n=>{const o=q.objectiveGraph.nodes.find(x=>x.id===n.id);return o&&o.kind==='ATOMIC'&&loose(o.description||'')===loose(n.description||'')});
 const byId=Object.fromEntries(graph.nodes.map(n=>[n.id,n])),inRound=new Set(),mark=id=>{inRound.add(id);byId[id].children.forEach(mark)};
 for(const n of graph.nodes)if(n.round_constraint==='IN_ONE_ROUND')mark(n.id);
 let order=nodes;
 if(same)order=[...nodes].sort((a,b)=>q.objectiveGraph.nodes.find(x=>x.id===a.id).index-q.objectiveGraph.nodes.find(x=>x.id===b.id).index);
 const mfTexts=order.map(n=>n.description||'');
 const matches=pair(oldIdx.map(i=>oldTexts[i]),mfTexts),oldFor=new Map([...matches].map(([a,b])=>[b,oldIdx[a]]));
 const objectives=[],rules=[];
 order.forEach((n,j)=>{
  const old=oldFor.get(j),mfText=mfTexts[j];let text;
  if(old!==undefined){
   const cur=oldTexts[old],wikiCur=w?Math.max(0,...w.objectives.map(o=>similarity(cur,o.text))):0,wikiMf=w?Math.max(0,...w.objectives.map(o=>similarity(mfText,o.text))):0;
   // Keep the existing wording when it matches, adds detail ("(100 damage)"),
   // or the wiki backs it over MetaForge's.
   const detailed=loose(cur).includes(loose(mfText));
   if(similarity(cur,mfText)>=.85||detailed||wikiCur>wikiMf)text=cur;else text=bullet(mfText);
   if(similarity(cur,mfText)<.85&&!detailed&&wikiCur>wikiMf)report.conflicts.push(`${q.name}: kept “${strip(cur)}” (wiki agrees) over MetaForge “${mfText}”`);
  }else{
   text=bullet(mfText);
   const onWiki=w&&w.objectives.some(o=>similarity(mfText,o.text)>=.8);
   if(w&&!onWiki&&!n.optional)report.conflicts.push(`${q.name}: “${mfText}” is on MetaForge but not the wiki`);
  }
  // The quest card shows one-round rules from the graph, so drop the old
  // inline markers rather than say it twice.
  if(inRound.has(n.id))text=text.replace(/^(●\s*)in one round:\s*/i,'$1').replace(/\s*\(in one round\)/i,'');
  // Near-identical wording can still disagree on a count.
  const digits=t=>(strip(t).match(/\d+/g)||[]).join(',');
  if(old!==undefined&&similarity(oldTexts[old],mfText)>=.85&&!loose(oldTexts[old]).includes(loose(mfText))&&digits(oldTexts[old])!==digits(mfText))report.conflicts.push(`${q.name}: kept “${strip(text)}”${w?` (wiki: “${w.objectives.reduce((a,o)=>similarity(o.text,mfText)>similarity(a,mfText)?o.text:a,'')}”)`:''} over MetaForge “${mfText}”`);
  if(n.optional&&!/\(optional\)/i.test(text))text=bullet('(Optional) '+strip(text));
  objectives.push(text);
  const prior=old!==undefined?q.objectiveRules?.[old]:null;
  // Map assignment: the curated/derived maps of the matched objective, else
  // a map named in the text, else the maps of the previous step.
  let maps,isTurnIn;
  if(old!==undefined){maps=prior?.maps||legacy[old].maps;isTurnIn=prior?.turnIn??legacy[old].turnIn}
  else{
   isTurnIn=turnIn(text,n);
   // Map keys are named after their map ("Dam Surveillance Key").
   const named=allMaps.filter(k=>aliases[k].test(text)||(k==='dam-battlegrounds'&&/\bdam\b/i.test(text)));
   const questScope=q.maps.includes('any')?[...allMaps]:[...q.maps];
   // A required step continues where the previous one happened; an optional
   // extra that names no map can be picked up anywhere the quest goes.
   maps=isTurnIn?[...allMaps]:named.length?named:n.optional?questScope:rules.filter(r=>!r.turnIn).at(-1)?.maps||questScope;
  }
  n.index=j;
  rules.push({maps:[...maps],optional:!!n.optional,sourceNode:n.id,...(isTurnIn?{turnIn:true}:{}),...Object.fromEntries(Object.entries(prior||{}).filter(([k])=>['optionalNotice','displayCount','substep','requiresObjectives'].includes(k)))});
 });
 const remap=oldTexts.map((_,i)=>{for(const [j,o] of oldFor)if(o===i)return j;return -1});
 for(const r of rules)if(r.requiresObjectives)r.requiresObjectives=r.requiresObjectives.map(i=>remap[i]).filter(i=>i>=0);
 const changed=JSON.stringify(oldTexts)!==JSON.stringify(objectives)||remap.some((j,i)=>j!==i);
 if(changed){
  migration[q.id]=remap;
  const added=objectives.filter((_,j)=>!oldFor.has(j)).map(strip),removed=oldIdx.filter(i=>remap[i]<0).map(i=>strip(oldTexts[i])),reworded=[...oldFor].filter(([j,o])=>strip(objectives[j])!==strip(oldTexts[o])).map(([j,o])=>`“${strip(oldTexts[o])}” → “${strip(objectives[j])}”`);
  if(added.length||removed.length||reworded.length)report.objectives.push({quest:q.name,added,removed,reworded,headings:oldTexts.filter(heading).length});
 }
 // Remap every index-keyed curated field.
 if(q.choiceGroups)q.choiceGroups=q.choiceGroups.map(g=>({...g,options:g.options.map(o=>({...o,indices:o.indices.map(i=>remap[i]).filter(i=>i>=0),required:o.required.map(i=>remap[i]).filter(i=>i>=0)})).filter(o=>o.indices.length)})).filter(g=>g.options.length);
 if(q.objectiveDisplayOrder){const kept=q.objectiveDisplayOrder.map(i=>remap[i]).filter(i=>i>=0);q.objectiveDisplayOrder=[...kept,...objectives.map((_,j)=>j).filter(j=>!kept.includes(j))]}
 if(objectiveMaps[q.id]){
  const moved={};for(const [i,entry] of Object.entries(objectiveMaps[q.id]))if(remap[i]>=0)moved[remap[i]]=entry;
  // A replaced step usually happens at the same place: hand its marker to the
  // new objective in the same position when that one is new and unmarked.
  for(const [i,entry] of Object.entries(objectiveMaps[q.id]))if(remap[i]<0&&+i<objectives.length&&!oldFor.has(+i)&&!moved[i])moved[i]=entry;
  objectiveMaps[q.id]=moved;
 }
 q.objectives=objectives;q.objectiveRules=rules;q.objectiveGraph=graph;
 // ---- prerequisites: the game manifest is authoritative
 const pm=[...m.prerequisites].sort(),pc=[...q.prerequisites].sort();
 if(JSON.stringify(pm)!==JSON.stringify(pc))report.prerequisites.push(`${q.name}: [${pc}] → [${pm}] (MetaForge)`);
 q.prerequisites=m.prerequisites;
 for(const [name,s] of [['Hub',h],['wiki',w]])if(s&&JSON.stringify([...s.prerequisites].sort())!==JSON.stringify(pm))report.prerequisites.push(`${q.name}: ${name} lists [${[...s.prerequisites].sort()}], MetaForge [${pm}]`);
 // ---- report-only comparisons
 const votes=[m,h,w].filter(Boolean).map(s=>s.trader);if(votes.some(t=>t!==q.trader))report.traders.push(`${q.name}: tracker ${q.trader}; MetaForge ${m.trader}, Hub ${h?.trader}, wiki ${w?.trader??'–'}`);
 const sourceMaps=[h,w].filter(Boolean).map(s=>[...new Set(s.maps)].sort().join(','));if(sourceMaps.some(s=>s!==[...q.maps].sort().join(',')))report.maps.push(`${q.name}: tracker ${q.maps.join(', ')}; Hub ${h?.maps.join(', ')}; wiki ${w?.maps.join(', ')||'–'}`);
 if(h&&!sameItems(q.requiredItems,h.requiredItems))report.required.push(`${q.name}: tracker ${q.requiredItems.map(i=>i.qty+'× '+i.name).join(', ')||'none'}; Hub ${h.requiredItems.map(i=>i.qty+'× '+i.name).join(', ')||'none'}; MetaForge ${m.requiredItems.map(i=>i.qty+'× '+i.name).join(', ')||'none'}`);
 // Cosmetics and currency don't affect supplies or routing, and the sources
 // name them inconsistently, so compare the remaining items only.
 const useful=r=>r.filter(x=>!['cosmetic','coins','tokens','blueprint'].includes(x.type)&&!/outfit|colou?r\)|variant\)|charm|emote|backpack|^coins$|raider tokens|blueprint/i.test(x.name));
 const rewardSets=[['MetaForge',m.rewards],['wiki',w?.rewards]].filter(([,r])=>r&&!sameItems(useful(q.rewards),useful(r)));
 if(rewardSets.length===2)report.rewards.push(`${q.name}: tracker ${useful(q.rewards).map(i=>i.qty+'× '+i.name).join(', ')}; MetaForge ${useful(m.rewards).map(i=>i.qty+'× '+i.name).join(', ')}; wiki ${useful(w.rewards).map(i=>i.qty+'× '+i.name).join(', ')}`);
}

// ---- save migration: compose with any earlier migrations so every older
// save version maps straight to the newest objective numbering.
const prev=data.objectiveMigrations||{},version=data.objectiveVersion||0;
if(Object.keys(migration).length){
 const next={};
 for(const [from,map] of Object.entries(prev)){next[from]={};for(const [id,old] of Object.entries(map))next[from][id]=old.map(i=>i<0?-1:migration[id]?migration[id][i]??-1:i);for(const [id,m] of Object.entries(migration))if(!next[from][id])next[from][id]=m}
 next[version]=migration;data.objectiveMigrations=next;data.objectiveVersion=version+1;
}
data.questsBuiltFrom={hub:hub.updatedAt,metaforge:mf.updatedAt,wiki:wiki.updatedAt};
offline.workerSource=read('route-planner.js')+'\n'+read('route-worker.js');
const questsChanged=before!==JSON.stringify([data.quests,objectiveMaps]),changed=questsChanged||offline.workerSource!==load('offline-resources.js','ARCOffline').workerSource;
if(process.argv.includes('--check')){console.log(changed?'Quest data is out of date: run node tools/build-quests.js':'Quest data is up to date.');process.exit(changed?1:0)}

const original=read('offline-resources.js'),tail=original.slice(original.indexOf('\nlet offlineWorkerObjectURL'));
fs.writeFileSync(path.join(ROOT,'offline-resources.js'),`'use strict';\nglobalThis.ARCOffline=${JSON.stringify(offline)};`+tail);
fs.writeFileSync(path.join(ROOT,'objective-maps.js'),`'use strict';\nglobalThis.ARCObjectiveMaps=${JSON.stringify(objectiveMaps)};\n`);

const list=(title,rows,note='')=>`\n## ${title} (${rows.length})\n${note?note+'\n':''}\n${rows.length?rows.map(r=>'- '+r).join('\n'):'_None._'}\n`;
const md=`# Quest data report

Generated by \`node tools/build-quests.js\` from snapshots in \`tools/sources/\`:
[Arc Raiders Hub](${hub.source}) (updated ${hub.updatedAt}), [MetaForge](${mf.source}) (updated ${mf.updatedAt.slice(0,10)}) and the [ARC Raiders Wiki](${wiki.source}) (latest edit ${wiki.updatedAt.slice(0,10)}).

Objectives, objective structure and prerequisites follow MetaForge's quest manifests (the game's objective graph). Everything else below is reported, not changed.
${list('Quests missing from a source',report.missing)}
## Objective changes (${report.objectives.length} quests)
${report.objectives.map(o=>`\n### ${o.quest}\n${o.added.map(t=>`- Added: ${t}`).join('\n')}${o.added.length?'\n':''}${o.removed.map(t=>`- Removed: ${t}`).join('\n')}${o.removed.length?'\n':''}${o.reworded.map(t=>`- Reworded: ${t}`).join('\n')}`).join('\n')}
${list('Source conflicts to verify in-game',report.conflicts,'MetaForge and the wiki disagree on these objectives.')}${list('Prerequisite differences',report.prerequisites)}${list('Trader differences',report.traders,'The tracker value was kept.')}${list('Map differences',report.maps,'The tracker keeps its curated maps (narrowed where an “any map” quest only works on some maps).')}${list('Required item differences',report.required,'MetaForge omits most quest-specific pickups, so only Hub differences are listed.')}${list('Reward differences',report.rewards,'Listed only when both MetaForge and the wiki disagree with the tracker. Cosmetics, blueprints and currency are ignored. Reward quantities feed the Supplies targets, so these are worth checking.')}`;
// The report describes the last rebuild that changed quests; a rebuild that
// only refreshes the route worker keeps it.
if(questsChanged||!fs.existsSync(path.join(__dirname,'quest-data-report.md')))fs.writeFileSync(path.join(__dirname,'quest-data-report.md'),md);
console.log(`Rebuilt ${data.quests.length} quests: ${report.objectives.length} with objective changes, ${Object.keys(migration).length} renumbered, objective version ${data.objectiveVersion||0}.`);
