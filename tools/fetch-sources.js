#!/usr/bin/env node
'use strict';
// Downloads the three community quest sources and saves normalized snapshots
// in tools/sources/. build-quests.js only reads these snapshots, so a build is
// reproducible offline and source changes show up as a reviewable git diff.
//
//   node tools/fetch-sources.js
const fs=require('fs'),path=require('path'),{execFileSync}=require('child_process');
const OUT=path.join(__dirname,'sources');
const get=url=>execFileSync('curl',['-sSfL','-A','Mozilla/5.0 (arc-mission-control data build)','--max-time','60',url],{maxBuffer:1<<28}).toString();
const json=url=>JSON.parse(get(url));
const slug=s=>s.toLowerCase().replace(/[’']/g,'').replace(/&/g,'and').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
const plain=s=>String(s??'').replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g,'$1').replace(/'''?/g,'').replace(/^\s*●\s*/,'').replace(/\s+/g,' ').trim();
const MAPS={'dam':'dam-battlegrounds','dam-battlegrounds':'dam-battlegrounds','buried-city':'buried-city','spaceport':'spaceport','blue-gate':'the-blue-gate','stella-montis':'stella-montis','riven-tides':'riven-tides','pendola-pass':'pendola-pass','any':'any','frigate':'pendola-pass'};
const mapSlug=s=>MAPS[slug(s.replace(/^the /i,''))]||'unknown:'+slug(s);
const traderSlug=t=>/nomad|cassio/i.test(t)?'cassio':/tian\s*wen/i.test(t)?'tian-wen':slug(t);
const write=(name,value)=>{fs.writeFileSync(path.join(OUT,name),JSON.stringify(value,null,1)+'\n');console.log(`${name}: ${value.quests.length} quests`)};
fs.mkdirSync(OUT,{recursive:true});

// Arc Raiders Hub publishes the JSON behind https://arcraidershub.com/quests.
const hubRaw=json('https://arcraidershub.com/data/quests.json');
const hub={source:'https://arcraidershub.com/quests',updatedAt:hubRaw.updatedAt,quests:hubRaw.quests.map(q=>({id:q.id,name:q.name,trader:traderSlug(q.trader),maps:q.maps,prerequisites:q.prerequisites,objectives:q.objectives.map(plain),requiredItems:q.requiredItems,rewards:q.rewards,addedInUpdate:q.addedInUpdate}))};
const idByName=Object.fromEntries(hub.quests.map(q=>[slug(q.name),q.id]));
const idOf=name=>idByName[slug(name)]||slug(name);
write('hub.json',hub);

// MetaForge's database pages are rendered from this paginated API.
const mfRaw=[];for(let page=1;;page++){const j=json(`https://metaforge.app/api/arc-raiders/quests?page=${page}&limit=100`);mfRaw.push(...j.data);if(!j.pagination.hasNextPage)break}
const item=i=>({name:i.item?.name||i.item_id,qty:i.quantity});
const metaforge={source:'https://metaforge.app/arc-raiders/database/quests',updatedAt:mfRaw.map(q=>q.updated_at).sort().at(-1),quests:mfRaw.map(q=>({id:idOf(q.name),metaforgeId:q.id,name:q.name,trader:traderSlug(q.trader_name),
 prerequisites:q.manifest.prerequisites.map(p=>idOf(p.name)),objectives:q.objectives.map(plain),requiredItems:q.required_items.map(item),rewards:q.rewards.map(item),grantedItems:(q.granted_items||[]).map(item),
 objectiveGraph:{root:q.manifest.objective_root,nodes:q.manifest.objective_graph.map(n=>({id:n.id,kind:n.kind,description:n.description&&plain(n.description),hidden:n.hidden,optional:n.optional,required_count:n.required_count??0,round_constraint:n.round_constraint||'UNSPECIFIED',children:n.children,...(n.action?{action:n.action}:{})}))}})).sort((a,b)=>a.id.localeCompare(b.id))};
write('metaforge.json',metaforge);

// The wiki's quest table lacks prerequisites and objectives, so read every
// quest article's wikitext through the MediaWiki API.
const api='https://arcraiders.wiki/w/api.php?format=json&formatversion=2&';
const titles=new Set(hub.quests.map(q=>q.name));let cont='';
do{const j=json(api+'action=query&list=categorymembers&cmtitle=Category:Quests&cmlimit=500'+cont);for(const m of j.query.categorymembers)if(m.ns===0)titles.add(m.title);cont=j.continue?'&cmcontinue='+encodeURIComponent(j.continue.cmcontinue):''}while(cont);
const pages=[],list=[...titles];
for(let i=0;i<list.length;i+=40){const j=json(api+'action=query&prop=revisions&rvprop=content|timestamp&rvslots=main&redirects=1&titles='+encodeURIComponent(list.slice(i,i+40).join('|')));for(const p of j.query.pages)if(!p.missing&&!pages.some(o=>o.title===p.title))pages.push({title:p.title,revised:p.revisions[0].timestamp,text:p.revisions[0].slots.main.content})}
const quests=[];
for(const p of pages){
 if(!/\{\{Infobox[ _]quest/i.test(p.text))continue;
 const field=k=>(p.text.match(new RegExp('\\|\\s*'+k+'\\s*=\\s*([^\\n|]*)'))||[])[1]?.trim()||'';
 const section=(p.text.match(/== ?Objectives ?==([\s\S]*?)\n==[^=]/)||[])[1]||'';
 const objectives=[...section.matchAll(/\{\{QuestObjective\s*\|([^{}]*(?:\{\{[^{}]*\}\}[^{}]*)*)\}\}/g)].map(m=>({label:(m[1].match(/label\s*=\s*([\s\S]*?)(?:\s*\|\s*\w+\s*=|$)/)||[])[1],optional:/optional\s*=\s*yes|symbol\s*=\s*circleCheckmark/.test(m[1])})).filter(o=>o.label).map(o=>({text:plain(o.label),optional:o.optional}));
 const rewards=[...((p.text.match(/== ?Rewards ?==([\s\S]*?)\n==[^=]/)||[])[1]||'').matchAll(/\{\{Quest item\|reward\|([^}]*)\}\}/g)].map(m=>{const parts=m[1].split('|').map(s=>s.trim()),named=Object.fromEntries(parts.filter(s=>s.includes('=')).map(s=>s.split('=').map(x=>x.trim()))),pos=parts.filter(s=>!s.includes('='));return {name:pos.length?pos.at(-1):named.type==='coins'?'Coins':named.type==='tokens'?'Raider Tokens':named.type,qty:+(named.qty||1),...(named.type?{type:named.type}:{})}});
 const name=field('name')||p.title;
 quests.push({id:idOf(name),name,trader:traderSlug(field('trader')),maps:field('location').split(/[;,]/).map(s=>s.trim()).filter(Boolean).map(mapSlug),next:field('next').split(';').map(s=>s.trim()).filter(Boolean).map(idOf),objectives,oneRound:/in-one-round/.test(section),rewards,revised:p.revised});
}
for(const q of quests)q.prerequisites=quests.filter(o=>o.next.includes(q.id)).map(o=>o.id).sort();
quests.sort((a,b)=>a.id.localeCompare(b.id));
write('wiki.json',{source:'https://arcraiders.wiki/wiki/Quests',updatedAt:quests.map(q=>q.revised).sort().at(-1),quests});
